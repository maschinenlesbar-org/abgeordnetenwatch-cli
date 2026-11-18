// The limiter around the upstream transport: requests in flight, the per-minute window, a 429's
// pause, the bounded queue, and an abort that leaves the queue.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AwNetworkError, type HttpRequest, type HttpResponse } from "@maschinenlesbar.org/abgeordnetenwatch-client";
import { limitTransport } from "../src/mcp/limiter.js";

const ok = (status = 200, headers: Record<string, string> = {}): HttpResponse => ({ status, headers, body: Buffer.from("{}") });
const request = (signal?: AbortSignal): HttpRequest => ({ method: "GET", url: "https://x/", headers: {}, ...(signal === undefined ? {} : { signal }) }) as HttpRequest;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A transport whose answers the test releases one by one. */
function gated() {
  const started: (() => void)[] = [];
  const transport = () => new Promise<HttpResponse>((resolve) => started.push(() => resolve(ok())));
  return { started, transport };
}

test("at most inFlight requests at once; the next starts when one ends", async () => {
  const { started, transport } = gated();
  const limited = limitTransport(transport, { inFlight: 2 });
  const calls = [limited(request()), limited(request()), limited(request())];
  await tick();
  assert.equal(started.length, 2);
  started[0]?.();
  await calls[0];
  await tick();
  assert.equal(started.length, 3);
  started[1]?.();
  started[2]?.();
  await Promise.all(calls);
});

test("at most perMinute starts in 60 s: the next waits", async () => {
  let t = 1_000_000;
  const limited = limitTransport(async () => ok(), { perMinute: 2, now: () => t });
  await limited(request());
  await limited(request());
  const controller = new AbortController();
  let third = false;
  const pending = limited(request(controller.signal)).then(() => (third = true), () => "left");
  await tick();
  assert.equal(third, false, "the third waits for the window");
  t += 61_000;
  controller.abort();
  assert.equal(await pending, "left");
});

test("a 429 pauses every start for its Retry-After", async () => {
  let t = 0;
  let first = true;
  const limited = limitTransport(async () => (first ? ((first = false), ok(429, { "retry-after": "30" })) : ok()), { now: () => t });
  assert.equal((await limited(request())).status, 429);
  const controller = new AbortController();
  let started = false;
  const pending = limited(request(controller.signal)).then(() => (started = true), () => "left");
  await tick();
  assert.equal(started, false, "paused");
  controller.abort();
  assert.equal(await pending, "left");
});

test("a full queue refuses at once; an aborted waiter leaves the queue", async () => {
  const { started, transport } = gated();
  const limited = limitTransport(transport, { inFlight: 1, queue: 1 });
  const first = limited(request());
  const controller = new AbortController();
  const waiting = limited(request(controller.signal));
  await assert.rejects(limited(request()), (err: unknown) => err instanceof AwNetworkError && /busy/.test(err.message));
  controller.abort(new AwNetworkError("aborted by the test"));
  await assert.rejects(waiting, /aborted by the test/);
  const next = limited(request());
  started[0]?.();
  await first;
  await tick();
  assert.equal(started.length, 2, "the aborted waiter never started");
  started[1]?.();
  await next;
});
