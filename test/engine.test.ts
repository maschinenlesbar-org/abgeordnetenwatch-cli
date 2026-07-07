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

  await assert.rejects(() => engine.getJson("/start"), AwApiError);
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

  await assert.rejects(() => engine.getJson("/start"), AwApiError);
  assert.equal(mt.calls.length, 1);
});
