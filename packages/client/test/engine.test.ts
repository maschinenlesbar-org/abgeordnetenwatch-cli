// Engine-level tests driven through a mock transport: control-character
// sanitisation of attacker-controlled error text, and the redirect
// credential-strip / bound logic.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine, bigIntegerKeysOption, firstInexactNumber, scanNumbers } from "../src/engine.js";
import { AbgeordnetenwatchClient } from "../src/client.js";
import { AwApiError, AwParseError, AwValidationError, cutText, toWellFormed } from "../src/errors.js";
import {
  makeMockTransport,
  jsonResponse,
  rawResponse,
  redirectResponse,
  redirectWithoutLocation,
} from "./helpers.js";
import type { HttpRequest, HttpResponse } from "../src/http.js";

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

test("server text in an API error message is cut at 500 characters; body keeps it all", async () => {
  const long = "x".repeat(2000);
  const engine = new RequestEngine({
    transport: async () => ({
      status: 500,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ meta: { status_message: long } })),
    }),
    maxRetries: 0,
  });
  await assert.rejects(engine.getJson("/api/v2/parties"), (e: unknown) => {
    assert.ok(e instanceof AwApiError);
    assert.ok(e.message.includes(`${"x".repeat(500)}…`) && !e.message.includes("x".repeat(501)), e.message.length.toString());
    assert.ok(e.body.includes(long));
    return true;
  });
});

test("cutText never cuts inside a surrogate pair; toWellFormed replaces half a character", () => {
  assert.equal(cutText("ab\u{1f600}cd", 3), "ab");
  assert.equal(cutText("ab\u{1f600}cd", 4), "ab\u{1f600}");
  assert.equal(cutText("short", 10), "short");
  assert.equal(toWellFormed("a\ud83d b\ude00 \u{1f600}"), "a\ufffd b\ufffd \u{1f600}");
});

test("a server detail cut at 500 characters keeps the message well-formed", async () => {
  for (const detail of ["\u{1f600}".repeat(600), "a" + "\u{1f600}".repeat(600)]) {
    const engine = new RequestEngine({
      transport: async () => ({ status: 500, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ meta: { status_message: detail } })) }),
      maxRetries: 0,
    });
    await assert.rejects(engine.getJson("/api/v2/parties"), (err: Error) => {
      assert.equal(toWellFormed(err.message), err.message);
      assert.match(err.message, /…$/);
      return true;
    });
  }
});

test("a long URL cut in an error message never leaves half a character", () => {
  // Not a parseable URL, so it is shown as given; both cut points land inside a pair.
  for (const url of ["x" + "\u{1f600}".repeat(200) + "y", "\u{1f600}".repeat(200) + "yz"]) {
    const err = new AwApiError({ status: 500, url, method: "GET", body: "" });
    assert.equal(toWellFormed(err.message), err.message, url.length.toString());
    assert.match(err.message, /…\[\d+ chars\]…/);
  }
});

test("own messages quote a server or user value at most 200 characters long (L3)", async () => {
  const long = "x".repeat(5000);
  const redirect = new RequestEngine({ maxRedirects: 0, maxRetries: 0, transport: async () => ({ status: 302, headers: { location: `https://other.example/${long}` }, body: Buffer.alloc(0) }) });
  await assert.rejects(redirect.getJson("/api/v2/parties"), (err: Error) => err.message.length < 400 && /redirect to https:\/\/other\.example\/x+… not followed/.test(err.message));
  const html = new RequestEngine({ maxRetries: 0, transport: async () => ({ status: 200, headers: { "content-type": `text/${long}` }, body: Buffer.from("{}") }) });
  await assert.rejects(html.getJson("/api/v2/parties"), (err: Error) => err.message.length < 400 && /unexpected Content-Type "text\/x+…"/.test(err.message));
  const charset = new RequestEngine({ maxRetries: 0, transport: async () => ({ status: 200, headers: { "content-type": `application/json; charset=${long}` }, body: Buffer.from("{}") }) });
  await assert.rejects(charset.getJson("/api/v2/parties"), (err: Error) => err.message.length < 400 && /charset "x+…"/.test(err.message));
  const client = new AbgeordnetenwatchClient({ transport: async () => ({ status: 200, headers: {}, body: Buffer.from("{}") }) });
  await assert.rejects(client.get("parties", long), (err: Error) => err.message.length < 600 && /x+…/.test(err.message));
  await assert.rejects(client.list("parties", { filters: { [`f[${long}]`]: "1" } }), (err: Error) => err.message.length < 1000 && /x+…/.test(err.message));
  await assert.rejects(client.list("parties", { filters: { [`${long}`]: "1", [`${long}[gt]`]: "2" } }), (err: Error) => err.message.length < 1200 && /x+…/.test(err.message));
  await assert.rejects(client.list("parties", { [long]: 1 } as never), (err: Error) => err.message.length < 600 && /x+…/.test(err.message));
  await assert.rejects(client.list(long as never), (err: Error) => err.message.length < 800 && /x+…/.test(err.message));
});

test("credentials a server echoes are scrubbed from the error: Basic, user:password, password (L13)", async () => {
  // The engine sends the pair UTF-8 encoded (basicAuthorization), so that is the form a server echoes.
  const basic = Buffer.from("alice:pa ss-pw", "utf8").toString("base64");
  const body = JSON.stringify({ meta: { status: "error", status_message: `no: Basic ${basic} / alice:pa ss-pw / pa ss-pw` } });
  const engine = new RequestEngine({
    baseUrl: "https://alice:pa%20ss-pw@mirror.example",
    maxRetries: 0,
    transport: async () => ({ status: 401, headers: { "content-type": "application/json" }, body: Buffer.from(body) }),
  });
  await assert.rejects(engine.getJson("/api/v2/parties"), (err: AwApiError) => {
    for (const form of [basic, "alice:pa ss-pw", "pa ss-pw"]) assert.ok(!err.message.includes(form), err.message);
    assert.match(err.message, /no: Basic \*\*\* \/ \*\*\* \/ \*\*\*/);
    return true;
  });
});

test("a header named __proto__ is an ordinary header, never the prototype of the headers read (T12, 2026-10-21)", async () => {
  // A JavaScript transport may return any object; JSON.parse makes "__proto__" an own key.
  const headers = JSON.parse('{"__proto__":{"content-type":"text/html"}}') as Record<string, string>;
  const e = new RequestEngine({ transport: async () => ({ status: 200, headers, body: Buffer.from("<html>") }) });
  // With the prototype set, "text/html" was read as the Content-Type and named in the message.
  await assert.rejects(e.getJson("/x"), (err: Error) => /not valid JSON|parse JSON/.test(err.message) && !err.message.includes("text/html"));
  const fetchLike = new Headers([["__proto__", "x"], ["content-type", "application/json"]]);
  const f = new RequestEngine({ transport: async () => ({ status: 200, headers: fetchLike as unknown as Record<string, string>, body: Buffer.from('{"a":1}') }) });
  assert.deepEqual(await f.getJson("/x"), { a: 1 });
});

test("an answer error names the request: method and URL, userinfo redacted (D9, 2026-10-21)", async () => {
  const answers: Array<[string, () => HttpResponse]> = [
    ["unexpected Content-Type", () => rawResponse("<html>", "text/html")],
    ["not valid JSON", () => rawResponse("{", "application/json")],
    ["empty response body", () => rawResponse(" ", "application/json")],
    ["cannot be represented exactly", () => rawResponse('{"n":1e400}', "application/json")],
    ["unsupported response charset", () => rawResponse("{}", "application/json; charset=x-bogus")],
  ];
  const base = new URL("https://www.abgeordnetenwatch.de");
  base.username = "alice";
  base.password = "s3cret";
  for (const [what, respond] of answers) {
    const e = new RequestEngine({ baseUrl: base.href, transport: makeMockTransport(respond).transport });
    await assert.rejects(e.getJson("/api/v2/parties", { label: "x" }), (err: unknown) => {
      assert.ok(err instanceof AwParseError, what);
      assert.ok(err.message.startsWith(`GET ${base.protocol}//***@${base.host}/api/v2/parties?label=x: `), err.message);
      assert.ok(err.message.includes(what), err.message);
      assert.ok(!err.message.includes("s3cret"), err.message);
      return true;
    });
  }
});

test("bigIntegerKeys: a declared member's number is its exact literal as a string; others keep the rule (D3, 2026-10-21)", async () => {
  const body = '{"_version_":1858054135406919680,"small":{"_version_":5},"neg":{"\\u005fversion_":-12345678901234567890},' +
    '"s":{"_version_":"text"},"n":{"_version_":null},"arr":{"_version_":[1]},"t":"\\"_version_\\":1","n2":42}';
  const e = new RequestEngine({
    bigIntegerKeys: new Set(["_version_"]),
    transport: makeMockTransport(() => rawResponse(body, "application/json")).transport,
  });
  assert.deepEqual(await e.getJson("/x"), {
    _version_: "1858054135406919680", small: { _version_: "5" }, neg: { _version_: "-12345678901234567890" },
    s: { _version_: "text" }, n: { _version_: null }, arr: { _version_: [1] }, t: '"_version_":1', n2: 42,
  });
  assert.deepEqual([...e.bigIntegerKeys], ["_version_"]);
  // An undeclared big number is still refused; a declared member doesn't make others exact.
  const other = new RequestEngine({
    bigIntegerKeys: ["_version_"] as unknown as ReadonlySet<string>,
    transport: makeMockTransport(() => rawResponse('{"_version_":1858054135406919680,"id":12345678901234567890}', "application/json")).transport,
  });
  await assert.rejects(other.getJson("/x"), /the number 12345678901234567890 cannot be represented exactly/);
  // Malformed stays malformed: a declared member with a leading zero still fails JSON.parse.
  const malformed = new RequestEngine({ bigIntegerKeys: new Set(["_version_"]), transport: makeMockTransport(() => rawResponse('{"_version_":01}', "application/json")).transport });
  await assert.rejects(malformed.getJson("/x"), /not valid JSON/);
  for (const bad of [new Set([""]), new Set([1]), "x", 5, null]) {
    assert.throws(() => new RequestEngine({ bigIntegerKeys: bad as unknown as ReadonlySet<string> }),
      (err: unknown) => err instanceof AwValidationError && err.message === "Invalid option bigIntegerKeys: expected a set of non-empty member names.");
  }
  // The option reader copies a set or a list; undefined is none.
  const names = new Set(["a"]);
  const copy = bigIntegerKeysOption(names);
  names.add("b");
  assert.deepEqual([...copy], ["a"]);
  assert.deepEqual([...bigIntegerKeysOption(["x", "y"] as unknown as ReadonlySet<string>)], ["x", "y"]);
  assert.equal(bigIntegerKeysOption(undefined).size, 0);
  // Without declarations the scan is the plain number check.
  assert.equal(firstInexactNumber('{"a":"1e400","b":3e-324}'), "3e-324");
  assert.deepEqual(scanNumbers('{"a":1}'), { json: '{"a":1}', inexact: undefined });
});

test("text that is not valid is replaced with U+FFFD and reported through onWarning, never silently (D2, 2026-10-21)", async () => {
  const cases: Array<[string, Buffer, string, unknown, number]> = [
    // A lone surrogate written as an escape (high alone, low alone); a real pair and an escaped backslash stay.
    ["lone escapes", Buffer.from('{"a":"x\\ud800y","b":"\\udc00","c":"\\ud83d\\ude00","d":"\\\\ud800"}'), "application/json", { a: "x\ufffdy", b: "\ufffd", c: "\u{1f600}", d: "\\ud800" }, 2],
    // A lone surrogate in a member name.
    ["lone in a key", Buffer.from('{"\\udbff":1}'), "application/json", { "\ufffd": 1 }, 1],
    // Invalid UTF-8 bytes; a U+FFFD the server sent is not counted.
    ["invalid bytes", Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff, 0xc3]), Buffer.from('","b":"\ufffd"}')]), "application/json", { a: "\ufffd\ufffd", b: "\ufffd" }, 2],
    // A byte undefined in a single-byte charset.
    ["iso-8859-3", Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xa5]), Buffer.from('"}')]), "application/json; charset=iso-8859-3", { a: "\ufffd" }, 1],
  ];
  for (const [label, body, type, expected, count] of cases) {
    const warnings: string[] = [];
    const e = new RequestEngine({ onWarning: (m) => warnings.push(m), transport: makeMockTransport(() => rawResponse(body, type)).transport });
    const value = await e.getJson("/api/v2/parties", { label: "x" });
    assert.deepEqual(value, expected, label);
    assert.ok(!/[\ud800-\udfff]/u.test(JSON.stringify(value)), `${label}: well-formed`);
    assert.deepEqual(warnings, [
      `GET https://www.abgeordnetenwatch.de/api/v2/parties?label=x: ${count} ${count === 1 ? "character" : "characters"} of the answer ${count === 1 ? "was" : "were"} not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.`,
    ], label);
  }
  // Valid text: no warning; a throwing hook never fails the request.
  const quiet: string[] = [];
  const ok = new RequestEngine({ onWarning: (m) => quiet.push(m), transport: makeMockTransport(() => rawResponse('{"a":"\\u00fc\ufffd"}', "application/json")).transport });
  assert.deepEqual(await ok.getJson("/x"), { a: "ü\ufffd" });
  assert.deepEqual(quiet, []);
  const throwing = new RequestEngine({ onWarning: () => { throw new Error("hook"); }, transport: makeMockTransport(() => rawResponse('"\\ud800"', "application/json")).transport });
  assert.equal(await throwing.getJson("/x"), "\ufffd");
  assert.throws(() => new RequestEngine({ onWarning: "log" as unknown as () => void }), AwValidationError);
});
