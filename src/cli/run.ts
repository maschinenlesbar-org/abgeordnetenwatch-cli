// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import type { CliDeps } from "./io.js";
import { AwApiError, AwError } from "../client/errors.js";

/** Conventional CLI exit code for a usage error (bad/unknown option, no command). */
const USAGE_ERROR_EXIT_CODE = 2;

/**
 * Apply exitOverride + output redirection to every command in the tree.
 * commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass our error handling.
 */
function configureTree(command: Command, deps: CliDeps): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    writeErr: (str) => deps.io.err(str.replace(/\n$/, "")),
  });
  for (const child of command.commands) configureTree(child, deps);
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  const program = buildProgram(deps);
  configureTree(program, deps);

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // An explicitly requested --help / --version is a successful, intentional
      // output: exit 0.
      if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
        return 0;
      }
      // Everything else from commander is a usage error: an unknown option, an
      // unknown/missing command, a bad argument value, or a rejected filter.
      // Map these to the conventional CLI usage-error code (2) so scripts can
      // tell a usage mistake from a runtime/network error (1) or a 404 (4).
      return USAGE_ERROR_EXIT_CODE;
    }
    if (err instanceof AwApiError) {
      // err.message already includes any human-readable `detail` the API
      // returned (its meta.status_message); surface it as-is.
      deps.io.err(`Error: ${err.message}`);
      // The API uses a generic HTTP 500 both for an unknown id and for an
      // invalid filter operator. When it gave no message of its own, the most
      // likely cause is a bad filter, so add a hint; when a message is present
      // (e.g. "There is no party entity with id X") it is self-explanatory.
      if (err.status === 500 && !err.detail) {
        deps.io.err(
          "Hint: the API rejected the request. Check the filter operator " +
            "(valid: eq, ne, gt, gte, lt, lte, cn, sw) and field names.",
        );
      }
      // 429/503 are transient: the automatic retries (honouring Retry-After) were
      // already exhausted by the time we get here, so point the user at waiting
      // and at the knob that raises the retry count.
      if (err.isRetryable) {
        deps.io.err(
          "Hint: the API is rate-limiting or temporarily unavailable. Wait a " +
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
      deps.io.err(`Error: ${err.message}`);
      return 1;
    }
    deps.io.err(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
