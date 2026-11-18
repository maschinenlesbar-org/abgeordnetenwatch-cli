// A caller's AbortSignal ends a call at once, wherever it is: before the first request, in the
// transport, in the backoff sleep before a retry. The MCP server cancels a tool call this way
// (a client's cancellation, a disconnect, its own deadline). An abort is never retried.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AbgeordnetenwatchClient } from "../src/client.js";
import { AwNetworkError, AwValidationError } from "../src/errors.js";
import type { HttpRequest } from "../src/http.js";
import { jsonResponse, makeMockTransport } from "./helpers.js";

const envelope = {
  meta: { status: "ok", status_message: "", result: { count: 0, total: 0, range_start: 0, range_end: 0 } },
  data: [],
};

/** Rejects with an AwNetworkError saying the request was aborted. */
async function rejectsAborted(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof AwNetworkError, String(err));
    assert.match(err.message, /^GET https:\/\/www\.abgeordnetenwatch\.de\/api\/v2\/parties\S* failed: aborted$/);
    return true;
  });
}

test("an already aborted signal: no request is sent", async () => {
  const mock = makeMockTransport(() => jsonResponse(envelope));
  const client = new AbgeordnetenwatchClient({ transport: mock.transport });
  await rejectsAborted(client.list("parties", {}, { signal: AbortSignal.abort() }));
  assert.equal(mock.calls.length, 0);
});

test("an abort while the transport waits ends the call at once and aborts the transport's signal", async () => {
  const seen: HttpRequest[] = [];
  const hanging = (request: HttpRequest) => {
    seen.push(request);
    return new Promise<never>(() => {});
  };
  const client = new AbgeordnetenwatchClient({ transport: hanging, timeoutMs: 0 });
  const controller = new AbortController();
  const call = client.list("parties", {}, { signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  await rejectsAborted(call);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.signal?.aborted, true, "the transport is told to stop");
});

test("an abort during the backoff before a retry ends the call without the retry", async () => {
  const mock = makeMockTransport(() => jsonResponse({ error: "busy" }, 503));
  const controller = new AbortController();
  const client = new AbgeordnetenwatchClient({
    transport: mock.transport,
    maxRetries: 3,
    // A backoff that would never end on its own, and aborts the call once it has begun.
    sleep: () => {
      controller.abort();
      return new Promise<void>(() => {});
    },
  });
  await rejectsAborted(client.list("parties", {}, { signal: controller.signal }));
  assert.equal(mock.calls.length, 1, "no retry after the abort");
});

test("an aborted call is not retried, as a reset would be", async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = new AbgeordnetenwatchClient({
    transport: () => {
      calls += 1;
      controller.abort();
      return new Promise<never>(() => {});
    },
    maxRetries: 3,
    sleep: async () => {},
  });
  await rejectsAborted(client.count("parties", {}, { signal: controller.signal }));
  assert.equal(calls, 1);
});

test("get takes a signal too", async () => {
  const mock = makeMockTransport(() => jsonResponse(envelope));
  const client = new AbgeordnetenwatchClient({ transport: mock.transport });
  await assert.rejects(client.get("parties", 1, { signal: AbortSignal.abort() }), /parties\/1 failed: aborted$/);
  assert.equal(mock.calls.length, 0);
});

test("a signal that is not an AbortSignal is refused before any request", async () => {
  const mock = makeMockTransport(() => jsonResponse(envelope));
  const client = new AbgeordnetenwatchClient({ transport: mock.transport });
  for (const options of [{ signal: "stop" }, { signal: {} }, "x", null]) {
    await assert.rejects(client.list("parties", {}, options as never), AwValidationError, JSON.stringify(options));
  }
  assert.equal(mock.calls.length, 0);
});

test("without a signal nothing changes: a call that is not aborted completes", async () => {
  const mock = makeMockTransport(() => jsonResponse(envelope));
  const client = new AbgeordnetenwatchClient({ transport: mock.transport });
  const controller = new AbortController();
  assert.deepEqual((await client.list("parties", {}, { signal: controller.signal })).data, []);
  assert.deepEqual((await client.list("parties")).data, []);
});
