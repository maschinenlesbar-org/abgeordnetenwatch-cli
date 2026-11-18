// argv -> exit code, testable: no process.exit, the streams, the upstream transport and the
// moments to stop come in as deps (index.ts passes the real ones).

import type { Server } from "node:http";
import { nodeHttpTransport, type Transport } from "@maschinenlesbar.org/abgeordnetenwatch-client";
import { createLogger, type Logger } from "@maschinenlesbar.org/abgeordnetenwatch-log";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { HELP, parseConfig, type McpConfig } from "./config.js";
import { createHttpServer, isLoopback } from "./http.js";
import { limitTransport } from "./limiter.js";
import { createServerFactory } from "./server.js";
import { PROGRAM, VERSION } from "./version.js";

export const USAGE_EXIT = 2;

export interface RunDeps {
  stdout: (text: string) => void;
  /** One stderr line, without the newline. */
  stderr: (line: string) => void;
  /** The upstream transport (default: node:http). */
  transport?: Transport;
  /** Resolves when the server should stop: stdin's end on stdio, a signal. */
  stopped: Promise<void>;
  /** Called with the logger once the format is known (index.ts: Node's warnings). */
  onLogger?: (log: Logger) => void;
  /** Called with the HTTP server once it listens (tests read its port). */
  onListening?: (server: Server) => void;
  now?: () => Date;
}

export async function run(argv: readonly string[], deps: RunDeps): Promise<number> {
  const parsed = parseConfig(argv);
  if (parsed.kind === "help") {
    deps.stdout(HELP);
    return 0;
  }
  if (parsed.kind === "version") {
    deps.stdout(`${VERSION}\n`);
    return 0;
  }
  const format = parsed.kind === "run" ? parsed.config.logFormat : "text";
  const log = createLogger({ program: PROGRAM, format, write: deps.stderr, ...(deps.now === undefined ? {} : { now: deps.now }) });
  if (parsed.kind === "error") {
    log.error("mcp", `${parsed.message} See --help.`);
    return USAGE_EXIT;
  }
  const config = parsed.config;
  deps.onLogger?.(log);
  if (config.baseUrl?.startsWith("http:") === true) {
    log.warn("http", `requests to ${config.baseUrl} are sent unencrypted (plain http).`);
  }
  const factory = createServerFactory({ config, transport: limitTransport(deps.transport ?? nodeHttpTransport), log });
  return config.transport === "stdio" ? serveOnStdio(factory, deps, log) : serveOnHttp(factory, config, deps, log);
}

async function serveOnStdio(factory: ReturnType<typeof createServerFactory>, deps: RunDeps, log: Logger): Promise<number> {
  const handle = serveStdio(factory);
  log.info("mcp", `${PROGRAM} ${VERSION} serving MCP on stdio`);
  await deps.stopped;
  await handle.close();
  return 0;
}

async function serveOnHttp(factory: ReturnType<typeof createServerFactory>, config: McpConfig, deps: RunDeps, log: Logger): Promise<number> {
  const server = createHttpServer(factory, config, log);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => resolve());
    });
  } catch (err) {
    log.error("http", `Could not listen on ${config.host}:${config.port}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;
  log.info("mcp", `${PROGRAM} ${VERSION} serving MCP on http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${port}/mcp`);
  if (!isLoopback(config.host)) {
    log.warn("http", `listening on ${config.host}, not loopback: anyone who reaches this port can call the tools. The server has no authentication; put it behind a proxy that has.`);
  }
  deps.onListening?.(server);
  await deps.stopped;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return 0;
}
