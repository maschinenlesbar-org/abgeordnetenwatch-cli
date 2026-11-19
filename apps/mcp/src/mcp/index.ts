#!/usr/bin/env node
// Binary entry point. On stdio, stdout is the protocol: nothing else may write there, so the
// console goes to stderr. The server stops when stdin ends (a stdio client closed it) or on
// SIGINT/SIGTERM, exiting 0 or 130/143: in a container this process is PID 1, which ignores a
// signal nothing listens for.

import { format } from "node:util";
import { installWarningLog } from "@maschinenlesbar.org/abgeordnetenwatch-log";
import { run } from "./run.js";

console.log = console.error;
console.info = console.error;
console.debug = console.error;
console.warn = console.error;

const argv = process.argv.slice(2);
const stdio = !argv.some((arg, i) => arg === "--transport=http" || (arg === "--transport" && argv[i + 1] === "http"));

let received = false;
if (stdio) process.stdin.on("data", () => (received = true));
const stopped = new Promise<void>((resolve) => {
  if (stdio) process.stdin.once("end", () => resolve()).once("close", () => resolve());
});
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) process.once(signal, () => process.exit(code));
// A stdio client that went away: nothing left to answer.
process.stdout.on("error", () => process.exit(0));

const code = await run(argv, {
  stdout: (text) => process.stdout.write(text),
  stderr: (line) => process.stderr.write(`${line}\n`),
  stopped,
  stdinReceived: () => received,
  onLogger: (log) => {
    installWarningLog(process, log, "mcp");
    // What a dependency prints is a record too: every stderr line is one.
    const toLog = (...args: unknown[]): void => log.warn("mcp", format(...args));
    console.log = console.info = console.debug = console.warn = console.error = toLog;
  },
});
process.exit(code);
