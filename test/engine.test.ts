// Engine-level tests driven through a mock transport: control-character
// sanitisation of attacker-controlled error text, and the redirect
// credential-strip / bound logic.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine } from "../src/client/engine.js";
import { AwApiError } from "../src/client/errors.js";
import {
  makeMockTransport,
  jsonResponse,
  redirectResponse,
  redirectWithoutLocation,
} from "./helpers.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";

const CREDS = { Authorization: "Bearer secret", Cookie: "s=1", "X-API-Key": "k" };

/** Case-insensitively look up a header value on a recorded request. */
function header(req: HttpRequest, name: string): string | undefined {
  const hit = Object.entries(req.headers ?? {}).find(
    ([k]) => k.toLowerCase() === name.toLowerCase(),
  );
  return hit?.[1];
}

// Built via char codes so no raw control bytes ever appear in this source file.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI = String.fromCharCode(0x9b); // a C1 control

/** True if the string contains any C0/C1 control char except tab/newline. */
function hasControlChars(s: string): boolean {
  return [...s].some((c) => {
    const n = c.charCodeAt(0);
    return n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f);
  });
}

function apiErrorBody(statusMessage: string, status = 500): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ meta: { status_message: statusMessage } })),
  };
}

test("error detail is stripped of terminal control characters", async () => {
  // ESC + CSI + BEL interleaved with printable text.
  const evil = `boom${ESC}[31mred${BEL}${CSI}2J`;
  const mt = makeMockTransport(() => apiErrorBody(evil));
  const engine = new RequestEngine({
    baseUrl: "https://a.example",
    transport: mt.transport,
    maxRetries: 0,
  });

  await assert.rejects(
    () => engine.getJson("/x"),
    (err: unknown) => {
      assert.ok(err instanceof AwApiError);
      // The control bytes are gone from both the structured detail and the
      // human-readable message that run.ts prints to stderr...
      assert.ok(!hasControlChars(err.detail ?? ""));
      assert.ok(!hasControlChars(err.message));
      // ...while the printable characters are preserved.
      assert.equal(err.detail, "boom[31mred2J");
      return true;
    },
  );
});

test("cross-host redirect strips credential headers before the next hop", async () => {
  const mt = makeMockTransport((req) =>
    req.url.startsWith("https://a.example")
      ? redirectResponse("https://b.example/next")
      : jsonResponse({ ok: true }),
  );
  const engine = new RequestEngine({
    baseUrl: "https://a.example",
    transport: mt.transport,
    headers: { ...CREDS },
    maxRetries: 0,
  });

  await engine.getJson("/start");
  const hop = mt.calls[1]!;
  assert.equal(hop.url, "https://b.example/next");
  assert.equal(header(hop, "authorization"), undefined);
  assert.equal(header(hop, "cookie"), undefined);
  assert.equal(header(hop, "x-api-key"), undefined);
});

test("a cross-origin redirect drops every caller header, Proxy-Authorization and X-Auth-Token included", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => (++calls === 1 ? redirectResponse("https://b.example/next") : jsonResponse({})));
  const engine = new RequestEngine({
    baseUrl: "https://a.example",
    transport: mt.transport,
    userAgent: "ua-test",
    headers: { ...CREDS, "Proxy-Authorization": "Basic SECRET", "X-Auth-Token": "SECRET", "user-agent": "x" },
  });
  await engine.getJson("/start");
  assert.equal(header(mt.calls[0]!, "proxy-authorization"), "Basic SECRET");
  assert.deepEqual(mt.calls[1]!.headers, { Accept: "application/json", "User-Agent": "ua-test" });
});

test("same-origin redirect keeps credential headers", async () => {
  const mt = makeMockTransport((req) =>
    req.url.endsWith("/start")
      ? redirectResponse("https://a.example/next")
      : jsonResponse({ ok: true }),
  );
  const engine = new RequestEngine({
    baseUrl: "https://a.example",
    transport: mt.transport,
    headers: { ...CREDS },
    maxRetries: 0,
  });

  await engine.getJson("/start");
  assert.equal(header(mt.calls[1]!, "authorization"), "Bearer secret");
});

test("same-host https->http downgrade strips credential headers (AW-02)", async () => {
  const mt = makeMockTransport((req) =>
    req.url.startsWith("https://")
      ? redirectResponse("http://a.example/next")
      : jsonResponse({ ok: true }),
  );
  const engine = new RequestEngine({
    baseUrl: "https://a.example",
    transport: mt.transport,
    headers: { ...CREDS },
    maxRetries: 0,
  });

  await engine.getJson("/start");
  assert.equal(header(mt.calls[1]!, "authorization"), undefined);
});

test("exceeding maxRedirects surfaces an AwApiError instead of looping", async () => {
  const mt = makeMockTransport(() => redirectResponse("https://a.example/loop"));
  const engine = new RequestEngine({
    baseUrl: "https://a.example",
    transport: mt.transport,
    maxRedirects: 2,
    maxRetries: 0,
  });

  await assert.rejects(
    () => engine.getJson("/start"),
    (err: unknown) =>
      err instanceof AwApiError &&
      err.location === "https://a.example/loop" &&
      err.message === "HTTP 302 for GET https://a.example/loop: redirect to https://a.example/loop not followed",
  );
  // initial request + 2 followed redirects = 3 transport calls, then it stops.
  assert.equal(mt.calls.length, 3);
});

test("a 3xx without a Location header is surfaced, not followed forever", async () => {
  const mt = makeMockTransport(() => redirectWithoutLocation());
  const engine = new RequestEngine({
    baseUrl: "https://a.example",
    transport: mt.transport,
    maxRetries: 0,
  });

  await assert.rejects(
    () => engine.getJson("/start"),
    (err: unknown) =>
      err instanceof AwApiError && /: redirect not followed \(no Location header\)$/.test(err.message),
  );
  assert.equal(mt.calls.length, 1);
});

test("only 301/302/303/307/308 are followed; 300, 304, 305 surface naming the target", async () => {
  for (const status of [300, 304, 305, 306]) {
    const mt = makeMockTransport(() => redirectResponse("/elsewhere", status));
    const engine = new RequestEngine({ baseUrl: "https://a.example", transport: mt.transport, maxRetries: 0 });
    await assert.rejects(
      () => engine.getJson("/start"),
      (err: unknown) =>
        err instanceof AwApiError &&
        err.message === `HTTP ${status} for GET https://a.example/start: redirect to https://a.example/elsewhere not followed`,
      String(status),
    );
    assert.equal(mt.calls.length, 1, String(status));
  }
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0;
    const mt = makeMockTransport(() => (++calls === 1 ? redirectResponse("/next", status) : jsonResponse({ ok: 1 })));
    const engine = new RequestEngine({ baseUrl: "https://a.example", transport: mt.transport, maxRetries: 0 });
    assert.deepEqual(await engine.getJson("/start"), { ok: 1 }, String(status));
    assert.equal(mt.last().url, "https://a.example/next");
  }
});

test("a malformed Location surfaces as an AwApiError, not an unexpected TypeError", async () => {
  const mt = makeMockTransport(() => redirectResponse("http://[bad"));
  const engine = new RequestEngine({ baseUrl: "https://a.example", transport: mt.transport, maxRetries: 0 });
  await assert.rejects(
    () => engine.getJson("/start"),
    (err: unknown) => err instanceof AwApiError && /: redirect to http:\/\/\[bad not followed$/.test(err.message),
  );
  assert.equal(mt.calls.length, 1);
});

test("the redirect target in the message is redacted and stripped of control characters", async () => {
  const mt = makeMockTransport(() => redirectResponse(`https://u:pw@b.example/x${ESC}[31m`, 300));
  const engine = new RequestEngine({ baseUrl: "https://a.example", transport: mt.transport, maxRetries: 0 });
  await assert.rejects(
    () => engine.getJson("/start"),
    (err: unknown) =>
      err instanceof AwApiError &&
      !hasControlChars(err.message) &&
      !err.message.includes("pw") &&
      err.message.includes("redirect to https://***@b.example/x"),
  );
});
