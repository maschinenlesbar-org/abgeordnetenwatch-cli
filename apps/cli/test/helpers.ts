// Test helpers of the CLI: the log helpers and the CLI <-> library parity harness. The
// transport helpers (canned responses, the recording mock transport) live with the client,
// in packages/client/test/helpers.ts, and are re-exported here so every CLI test imports its
// helpers from one place.

import type { Transport, HttpRequest, HttpResponse } from "@maschinenlesbar.org/abgeordnetenwatch-client/internal/http";
import { AbgeordnetenwatchClient } from "@maschinenlesbar.org/abgeordnetenwatch-client/internal/client";
import type { CliDeps } from "../src/cli/io.js";
import { run } from "../src/cli/run.js";
import { jsonResponse, makeMockTransport } from "@maschinenlesbar.org/abgeordnetenwatch-client/test/helpers";

export * from "@maschinenlesbar.org/abgeordnetenwatch-client/test/helpers";

// ---- the log on stderr -------------------------------------------------------

/**
 * stderr with each text record's timestamp taken off: `ERROR [abgeordnetenwatch.api] HTTP 404 …`.
 * The format itself — timestamp, level, topic — is the conformance test's
 * (conformance-p23-log-format); the other tests check what was said, at which level
 * and under which topic.
 */
export function untimed(text: string): string {
  return text.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /gm, "");
}

/** What one input did through the CLI: exit code, output and the requests sent. */
export interface CliOutcome {
  code: number;
  out: string;
  err: string;
  requests: HttpRequest[];
}

/**
 * What one input did through the library: the value or the error, and the requests sent. The
 * shape is the kit's, which the shared conformance bodies (P24, P25) read: `error?.name`.
 */
export interface LibOutcome {
  ok: boolean;
  value?: unknown;
  /** What the call threw; anything but an Error is wrapped in one. */
  error?: Error;
  requests: HttpRequest[];
}

/**
 * CLI <-> library parity check. Runs `argv` through `run()` (the real program, its
 * client built on the recording mock transport) and `call(transport)` through the
 * library on the same transport, and returns both outcomes with the requests each
 * one sent. A parity test asserts that both reject with no request, or that both
 * send the identical request.
 */
export async function parity(
  argv: string[],
  call: (transport: Transport) => unknown,
  responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> = () =>
    jsonResponse({ meta: {}, data: [] }),
): Promise<{ cli: CliOutcome; lib: LibOutcome }> {
  const mt = makeMockTransport(responder);
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    io: { out: (t) => out.push(t), err: (t) => err.push(t) },
    createClient: (options) => new AbgeordnetenwatchClient({ ...options, transport: mt.transport }),
  };
  const code = await run(argv, deps);
  const cli: CliOutcome = { code, out: out.join("\n"), err: untimed(err.join("\n")), requests: [...mt.calls] };

  const before = mt.calls.length;
  let lib: LibOutcome;
  try {
    const value = await call(mt.transport);
    lib = { ok: true, value, requests: mt.calls.slice(before) };
  } catch (error) {
    lib = { ok: false, error: error instanceof Error ? error : new Error(String(error)), requests: mt.calls.slice(before) };
  }
  return { cli, lib };
}
