// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { AbgeordnetenwatchClient } from "../client/client.js";
import { MAX_TIMEOUT_MS } from "../client/http.js";
import { parseBaseUrl, parseBoundedInt, parseIntArg, parseUserAgentArg } from "./shared.js";
import { registerEntityCommands } from "./commands/entities.js";

/**
 * Single source of truth for the version: read from package.json at runtime
 * rather than duplicating a literal that can silently drift after a release bump.
 * From the compiled location (dist/src/cli/program.js) package.json is three
 * directories up; the same offset holds for the source under src/cli.
 */
function readVersion(): string {
  try {
    const pkgUrl = new URL("../../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();

/** Default dependencies: real client + real stdout/stderr/filesystem. */
export const defaultDeps: CliDeps = {
  io: defaultIO,
  createClient: (options) => new AbgeordnetenwatchClient(options),
};

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();

  program
    .name("abgeordnetenwatch")
    .description(
      "CLI for the open abgeordnetenwatch.de parliamentary data API " +
        "(https://www.abgeordnetenwatch.de/api)",
    )
    .version(VERSION)
    .option("--base-url <url>", "API base URL", parseBaseUrl, "https://www.abgeordnetenwatch.de")
    .option(
      "--timeout <ms>",
      "time limit per request in milliseconds, whole response included (0 disables)",
      parseBoundedInt(0, MAX_TIMEOUT_MS),
      30_000,
    )
    .option("--user-agent <ua>", "User-Agent header value", parseUserAgentArg)
    .option(
      "--max-retries <n>",
      "retries for transient 429/503 responses (0..10; each waits the server's Retry-After, up to 30 s)",
      parseBoundedInt(0, 10),
      2,
    )
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited)",
      parseIntArg,
      100 * 1024 * 1024,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .showHelpAfterError();

  registerEntityCommands(program, deps);

  return program;
}
