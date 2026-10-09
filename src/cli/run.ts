// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import { logOf, type CliDeps } from "./io.js";
import { DEFAULT_LOG_FORMAT, createLogger, logFormatFromArgv, type LogFormat, type Logger } from "./log.js";
import {
  AwApiError,
  AwError,
  AwNetworkError,
  AwParseError,
  AwValidationError,
  credentialsIn,
  echoedCredentialForms,
  redactCredentials,
  redactSecrets,
} from "../client/errors.js";
import { RESERVED_FILTER_FIELDS } from "../client/filters.js";

/** Conventional CLI exit code for a usage error (bad/unknown option, no command). */
const USAGE_ERROR_EXIT_CODE = 2;

/**
 * Apply exitOverride + output redirection to every command in the tree.
 * commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass our error handling.
 */
function configureTree(command: Command, deps: CliDeps, state: { errorLogged: boolean } = { errorLogged: false }): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    writeErr: (str) => writeCommanderErr(command, deps, state, str),
  });
  for (const child of command.commands) configureTree(child, deps, state);
}

/** `abgeordnetenwatch get`: the command's name with its parents'. */
function commandPath(command: Command): string {
  const names: string[] = [];
  for (let c: Command | null = command; c !== null; c = c.parent) names.unshift(c.name());
  return names.join(" ");
}

/**
 * commander's stderr output as log records, one per line. Its `error: …` is an ERROR of
 * `cli`, with a following `(Did you mean …?)` line appended to that same record; the
 * help it shows after an error is one INFO record per non-blank line. The program run
 * without a command (and `help <unknown name>`) makes commander show the help as an
 * error (exit 1, so 2 here) with no `error:` line: an ERROR record "missing command:
 * `abgeordnetenwatch <subcommand>`" comes first, so every failed run has one.
 */
function writeCommanderErr(command: Command, deps: CliDeps, state: { errorLogged: boolean }, str: string): void {
  const log = logOf(deps);
  const text = str.replace(/\n$/, "");
  // The blank line commander writes between an error and the help it shows after.
  if (text.trim() === "") return;
  if (text.startsWith("error: ")) {
    state.errorLogged = true;
    log.error("cli", text.slice("error: ".length).replace(/\n(\(Did you mean .*\?\))$/, " $1"));
    return;
  }
  if (!state.errorLogged) {
    state.errorLogged = true;
    log.error("cli", `missing command: \`${commandPath(command)} <subcommand>\``);
  }
  for (const line of text.split("\n")) if (line.trim() !== "") log.info("cli", line.trimEnd());
}

/**
 * The names (long and short) of the program's own options that require a value
 * (`--user-agent`). Only the program's: commander takes them out of argv wherever they
 * stand, before a subcommand sees the rest, so a subcommand's `--sort-by` never swallows
 * a `--log-format` after it.
 */
function valueOptionsOf(program: Command): Set<string> {
  const names = new Set<string>();
  for (const option of program.options) {
    if (!option.required) continue;
    if (option.long !== undefined) names.add(option.long);
    if (option.short !== undefined) names.add(option.short);
  }
  return names;
}

/** Query parameters the CLI sets itself; any other parameter is a filter. */
const NON_FILTER_PARAMS: ReadonlySet<string> = new Set(RESERVED_FILTER_FIELDS);

/** True when the request URL carried at least one filter parameter. */
function hasFilters(url: string): boolean {
  try {
    return [...new URL(url).searchParams.keys()].some((key) => !NON_FILTER_PARAMS.has(key));
  } catch {
    return false;
  }
}

/**
 * Replace the userinfo of every URL in `text` with `***`, the form `redactUrl` gives
 * (`https://user:secret@host` becomes `https://***@host`). Text-based, so it also covers
 * a URL that does not parse; a backstop behind the exact-string redaction below.
 */
export function redactUserinfo(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#']*@/gi, "$1***@");
}

/**
 * The options whose value is the base URL: a `user:password@host` given there without
 * its scheme is still a credential (anywhere else a bare `a:b@c` is not).
 */
const BASE_URL_FLAGS = ["--base-url"];

/** The values of the `flags` in `argv`, in both forms (`--flag value`, `--flag=value`). */
function flagValues(argv: readonly string[], flags: readonly string[]): string[] {
  const found: string[] = [];
  argv.forEach((token, i) => {
    const next = argv[i + 1];
    if (flags.includes(token) && next !== undefined) found.push(next);
    const eq = token.indexOf("=");
    if (eq > 0 && flags.includes(token.slice(0, eq))) found.push(token.slice(eq + 1));
  });
  return found;
}

/** The secrets of a run, and the two ways they are replaced. */
export interface Redaction {
  /** stdout text: the userinfo of every URL-like argument replaced (`***@`). */
  out(text: string): string;
  /** stderr text, a record's message: the same. */
  err(text: string): string;
}

/**
 * The secrets of the run in `argv`. Commander echoes rejected values in its errors
 * (`--base-url`, an unknown command, a stray argument, an invalid filter), and the
 * library's messages name rejected values: whatever path a credential takes to stdout or
 * stderr, the exact userinfo (as `credentialsIn` finds it, plus its JSON-escaped form) is
 * replaced by `***`. A pattern alone can't delimit a password with spaces, quotes, `#`,
 * `?` or `/`; the exact strings can. Without credentials the text passes through unchanged.
 */
export function redactionFor(argv: readonly string[]): Redaction {
  // An `--option=value` token is echoed as its value alone.
  const values = argv.map((token) =>
    token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token,
  );
  const secrets = new Set<string>();
  const echoed = new Set<string>();
  const passwords = new Set<string>();
  // A base URL typed without its scheme is read as if it had one.
  const baseUrls = flagValues(argv, BASE_URL_FLAGS).map((value) => (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) ? value : `http://${value}`));
  for (const source of [...values, ...baseUrls]) {
    for (const secret of credentialsIn(source)) {
      secrets.add(secret);
      secrets.add(JSON.stringify(secret).slice(1, -1));
      // What a server echoes back: the Basic value and the decoded user:password on
      // stdout and stderr, the password alone (it may well occur in the data) on stderr.
      const [basic, pair, password] = echoedCredentialForms(secret);
      if (basic !== undefined) echoed.add(basic);
      if (pair !== undefined) echoed.add(pair);
      if (password !== undefined) passwords.add(password);
    }
  }
  if (secrets.size === 0) return { out: (text) => text, err: (text) => text };
  const list = [...secrets];
  // Longest first, so a password never leaves half of the user:password around it.
  const echoedList = [...echoed].sort((a, b) => b.length - a.length);
  const passwordList = [...passwords].sort((a, b) => b.length - a.length);
  const out = (text: string): string => redactSecrets(redactUserinfo(redactCredentials(text, list)), echoedList);
  return { out, err: (text) => redactSecrets(out(text), passwordList) };
}

/**
 * `deps` that keep the secrets of this run (`redactionFor`) out of everything they
 * print: `io.out` is redacted, and the log (`deps.log`) replaces them in each record's
 * message before formatting it, then writes to the raw `io.err`, so the frame is never
 * touched. `io.err` itself is redacted too, for anything that writes to stderr without
 * the log.
 */
export function withRedactedOutput(deps: CliDeps, argv: readonly string[]): CliDeps {
  const redaction = redactionFor(argv);
  const { out, err } = deps.io;
  return {
    ...deps,
    io: { ...deps.io, out: (text) => out(redaction.out(text)), err: (text) => err(redaction.err(text)) },
    log: createLogger({
      format: logFormatFromArgv(argv),
      write: err,
      redact: redaction.err,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }),
  };
}

/**
 * The log for what happens outside `run()`, in the bin shim: a stdout write error
 * (`handleOutputErrors`) and Node's process warnings. Its format is the one argv asks
 * for (`logFormatFromArgv`), and it replaces the secrets of argv like the run's own log;
 * it writes to the raw stderr.
 */
export function processLogger(argv: readonly string[]): Logger {
  return createLogger({
    format: logFormatFromArgv(argv),
    write: (line) => process.stderr.write(line + "\n"),
    redact: redactionFor(argv).err,
  });
}

/**
 * The log area of an `AwError` that is neither an API error nor a usage error: the
 * connection (`http`), a malformed answer (`api`: bad JSON, the wrong shape or content
 * type, an unknown charset — the API's answer as much as an error status is), else `cli`.
 */
function areaOf(err: AwError): string {
  if (err instanceof AwNetworkError) return "http";
  if (err instanceof AwParseError) return "api";
  return "cli";
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  // The log replaces the secrets of the run in every message, in either format.
  deps = withRedactedOutput(deps, argv);
  const program = buildProgram(deps);
  configureTree(program, deps);
  // For the records of a parse error: the scan of argv, now knowing which of the
  // program's options take a value, as commander reads them.
  if (deps.log !== undefined) deps.log.format = logFormatFromArgv(argv, valueOptionsOf(program));
  // One source for the format once commander has parsed argv: its value, not the scan
  // of argv (an option's value can look like --log-format; `--` ends the scan, not
  // commander's parse of a value). Ancestors' hooks run first, so this precedes every
  // other preAction check.
  const log = deps.log;
  program.hook("preAction", (_program, actionCommand) => {
    const format = (actionCommand.optsWithGlobals() as { logFormat?: LogFormat }).logFormat;
    if (log !== undefined) log.format = format ?? DEFAULT_LOG_FORMAT;
  });

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Explicitly requested help or version output is a success: --help
      // (commander.helpDisplayed), --version (commander.version) and the `help`
      // subcommand (`help`, `help list`: commander.help with exit code 0) exit 0.
      // Help printed because no command was given (bare invocation, `help nope`)
      // carries exit code 1 and stays a usage error below.
      if (err.exitCode === 0) return 0;
      // Everything else from commander is a usage error: an unknown option, an
      // unknown/missing command, a bad argument value, or a rejected filter.
      // Map these to the conventional CLI usage-error code (2) so scripts can
      // tell a usage mistake from a runtime/network error (1) or a 404 (4).
      return USAGE_ERROR_EXIT_CODE;
    }
    const log = logOf(deps);
    if (err instanceof AwValidationError) {
      // The library rejected an input before sending anything (a rule the
      // commander parsers do not cover on their own, such as one that spans two
      // options): a usage error, like a rejected option value.
      log.error("cli", err.message);
      return USAGE_ERROR_EXIT_CODE;
    }
    if (err instanceof AwApiError) {
      // err.message already includes any human-readable `detail` the API
      // returned (its meta.status_message); surface it as-is.
      log.error("api", err.message);
      // The API answers many request problems with a generic HTTP 500. With a
      // message of its own (e.g. "There is no party entity with id X") it is
      // self-explanatory. Without one, and only when the request carried filters,
      // point at them: operators are already checked locally, so the field names
      // and values are what is left. A plain server fault gets no hint.
      if (err.status === 500 && !err.detail && hasFilters(err.url)) {
        log.info(
          "api",
          "the API rejected the request without a reason. Check the filter " +
            "field names and values.",
        );
      }
      // 429/503 are transient. When the server asked for a wait longer than the client
      // sleeps, nothing was retried and more retries cannot help: say to wait that long
      // (the message names it). Otherwise the automatic retries were exhausted, so point
      // the user at waiting and at the knob that raises the retry count.
      if (err.isRetryable && err.retryAfterMs !== undefined) {
        log.info(
          "api",
          `the server asked clients to wait ${Math.ceil(err.retryAfterMs / 1000)} s. ` +
            "Wait that long before trying again; --max-retries cannot help, the client " +
            "never waits longer than 30 s by itself.",
        );
      } else if (err.isRetryable) {
        log.info(
          "api",
          "the API is rate-limiting or temporarily unavailable. Wait a " +
            "moment and retry; --max-retries raises the number of automatic retries.",
        );
      }
      // Map a few notable statuses to distinct exit codes for scripting.
      // A genuine 404 (an unknown collection path) is distinct from the 500 the
      // API returns for a missing id.
      if (err.status === 404) return 4;
      return 1;
    }
    if (err instanceof AwError) {
      log.error(areaOf(err), err.message);
      return 1;
    }
    log.error("cli", `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
