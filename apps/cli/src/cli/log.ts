// The CLI's log: the records of @maschinenlesbar.org/abgeordnetenwatch-log (shared with the MCP
// server), with this program's name in every topic (`abgeordnetenwatch.<area>`), and reading
// `--log-format` from argv before commander parses. See packages/log/src/log.ts for the format.

import { createLogger as createRecordLogger, DEFAULT_LOG_FORMAT, logFormatProblem, type LogFormat, type Logger } from "@maschinenlesbar.org/abgeordnetenwatch-log";

export * from "@maschinenlesbar.org/abgeordnetenwatch-log";

export const LOG_PROGRAM = "abgeordnetenwatch";

/** A logger whose topics are `abgeordnetenwatch.<area>`. */
export function createLogger(options: Omit<Parameters<typeof createRecordLogger>[0], "program">): Logger {
  return createRecordLogger({ program: LOG_PROGRAM, ...options });
}

/**
 * The `--log-format` in `argv`, read before commander parses it: commander's own
 * usage errors are logged too, and they happen while parsing. A missing or unknown
 * value gives the default here; commander then reports an unknown one. The first
 * `--log-format` counts: commander keeps it and rejects a second one
 * (`forbidRepeatedOptions`), so that error is logged in the first one's format. This
 * scan is only for the records of a parse error: once commander has parsed argv, its
 * value is the format (`run()`), so `--user-agent --log-format=jsonl` (a User-Agent)
 * logs text. `valueOptions` names the program's options that take a value
 * (`--user-agent`): the token after one is its value, never an option, as commander
 * reads it, so `--user-agent --log-format jsonl` and `--user-agent -- --log-format jsonl`
 * agree with commander in a parse error too. A subcommand's value option (`--sort-by`)
 * does not count: commander takes the program's own options out of argv first, so
 * `list politicians --sort-by --log-format jsonl` is jsonl and a `--sort-by` without its
 * value.
 */
export function logFormatFromArgv(argv: readonly string[], valueOptions: ReadonlySet<string> = new Set()): LogFormat {
  let format: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--") break;
    if (token !== "--log-format" && valueOptions.has(token)) {
      i++;
      continue;
    }
    if (token === "--log-format") format = argv[i + 1];
    else if (token.startsWith("--log-format=")) format = token.slice("--log-format=".length);
    else continue;
    break;
  }
  return format !== undefined && logFormatProblem(format) === undefined ? (format as LogFormat) : DEFAULT_LOG_FORMAT;
}
