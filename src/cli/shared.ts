// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, the filter parser, and the JSON result renderer.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { logOf, type CliDeps } from "./io.js";
import { cleartextProblem, DEFAULT_BASE_URL, type EngineOptions } from "../client/engine.js";
import { AwError, quoteValue } from "../client/errors.js";
import { baseUrlProblem, headerValueProblem, nonBlankProblem } from "../client/validate.js";

/**
 * commander value-parser: a non-negative decimal integer.
 *
 * Strict by design — only a plain run of ASCII digits is accepted. This rejects
 * the values `Number()` would otherwise silently coerce: hex/binary/octal
 * literals, scientific notation, a leading `+`, surrounding whitespace, and the
 * empty string. Values beyond `Number.MAX_SAFE_INTEGER` are rejected too.
 */
export function parseIntArg(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError(
      `Value out of range; must be between 0 and ${Number.MAX_SAFE_INTEGER}.`,
    );
  }
  return n;
}

/**
 * Build a commander value-parser for a non-negative decimal integer constrained
 * to [min, max] (same strict syntax as {@link parseIntArg}).
 */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  return (value: string) => {
    const n = parseIntArg(value);
    if (n < min || n > max) {
      throw new InvalidArgumentError(`Value out of range; must be between ${min} and ${max}.`);
    }
    return n;
  };
}

/**
 * commander value-parser: a value that is not blank. A blank filter would
 * otherwise be dropped and the command would silently run unfiltered.
 */
export function parseNonEmpty(value: string): string {
  const reason = nonBlankProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return value;
}

/**
 * commander value-parser for a value that ends up in an HTTP header (`--user-agent`):
 * the library's rule (headerValueProblem: not blank, no control characters but tab,
 * nothing above U+00FF) as a usage error, which also forecloses header injection.
 */
export function parseHeaderValue(value: string): string {
  const reason = headerValueProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return value;
}

/**
 * commander value-parser for `--base-url`: the library's rule (baseUrlProblem: an
 * absolute http(s) URL, no query, fragment or surrounding whitespace) as a usage
 * error at parse time. The engine checks the same rule again for library users.
 */
export function parseBaseUrl(value: string): string {
  const reason = baseUrlProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return value;
}

/**
 * Parse positional `key=value` filter arguments into a filters object.
 *
 * The key may carry a bracket operator (`year_of_birth[gt]=1990`) or be a plain
 * field / related-entity id (`sex=f`, `politician=184945`); both pass through
 * verbatim to the query string. The value keeps everything after the first `=`,
 * so values may themselves contain `=`. A missing `=` or empty key is an error.
 */
export function parseFilters(args: string[]): Record<string, string> {
  // `__proto__`, `constructor` and `prototype` never get here: filterArg rejects them
  // (filterKeyProblem), so plain assignment can't set a prototype.
  const filters: Record<string, string> = {};
  for (const arg of args) {
    const eq = arg.indexOf("=");
    if (eq <= 0) {
      throw new InvalidArgumentError(
        `Invalid filter "${quoteValue(arg)}". Use key=value, e.g. sex=f or 'year_of_birth[gt]=1990'.`,
      );
    }
    filters[arg.slice(0, eq)] = arg.slice(eq + 1);
  }
  return filters;
}

/**
 * Make giving a single-value option twice a usage error, on `command` and every
 * subcommand. Commander keeps the last value silently: `--range-end 5 --range-end 500`
 * fetched 500 rows, and `--base-url a --base-url b` asked b, with nothing telling the
 * user a value was dropped. Flags without a value are left alone. Call it once on a
 * freshly built program: the check counts per Option object.
 */
export function forbidRepeatedOptions(command: Command): void {
  for (const option of command.options) {
    if ((!option.required && !option.optional) || option.variadic) continue;
    const parse = option.parseArg;
    let given = false;
    const guarded = (value: string, previous: unknown): unknown => {
      if (given) throw new InvalidArgumentError(`${option.long ?? option.short} may be given only once.`);
      given = true;
      return parse === undefined ? value : parse(value, previous);
    };
    option.parseArg = guarded as typeof option.parseArg;
  }
  for (const child of command.commands) forbidRepeatedOptions(child);
}

export interface GlobalOptions {
  baseUrl?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  compact?: boolean;
}

/** Translate resolved global CLI options into client EngineOptions. */
export function toEngineOptions(global: GlobalOptions): EngineOptions {
  const options: EngineOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

/**
 * Escape the control characters JSON.stringify leaves raw. It escapes C0 (including
 * ESC) but not DEL or the C1 range U+0080–U+009F, and terminals may act on those —
 * U+009B is the 8-bit form of CSI. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c >= 0x7f && c <= 0x9f) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/**
 * JSON.stringify, pretty or compact. A deeply nested value (a hostile or broken
 * response) overflows the stack — the pretty form far sooner than the compact one,
 * which is why the message suggests --compact. The RangeError becomes an AwError so
 * the CLI prints a clear message instead of "Unexpected error: Maximum call stack
 * size exceeded".
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    return compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  } catch (err) {
    if (err instanceof RangeError) {
      throw new AwError(
        compact
          ? "The response is nested too deeply to print."
          : "The response is nested too deeply to pretty-print; try --compact.",
        { cause: err },
      );
    }
    throw err;
  }
}

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(stringifyJson(value, global.compact === true));
  deps.io.out(text);
}

/**
 * Log one warning (a WARN record of `abgeordnetenwatch.http`) when the effective base URL is plain `http:` to
 * a host other than loopback (cleartextProblem): requests, and any credentials in the
 * URL, travel unencrypted. Called once per run, after the options are parsed and before
 * the first request; stdout and the exit code are untouched.
 */
export function warnOnCleartext(deps: CliDeps, global: GlobalOptions): void {
  const problem = cleartextProblem(global.baseUrl ?? DEFAULT_BASE_URL);
  if (problem !== undefined) logOf(deps).warn("http", problem);
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    warnOnCleartext(deps, global);
    const client = deps.createClient(toEngineOptions(global));
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
