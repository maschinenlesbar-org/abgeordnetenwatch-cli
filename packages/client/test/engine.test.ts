// Engine-level tests driven through a mock transport: control-character
// sanitisation of attacker-controlled error text, and the redirect
// credential-strip / bound logic.

import { test } from "node:test";
import assert from "node:assert/strict";
import { TextDecoder } from "node:util";
import { execFileSync } from "node:child_process";
import { RequestEngine, bigIntegerKeysOption, firstInexactNumber, sanitizeServerText, scanNumbers } from "../src/engine.js";
import { AbgeordnetenwatchClient } from "../src/client.js";
import { AwApiError, AwParseError, AwValidationError, TextBuilder, cutText, echoedCredentialForms, redactUrlUserinfo, toWellFormed } from "../src/errors.js";
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
      // ...whole sequences, not just their control bytes: the printable text around them stays.
      assert.equal(err.detail, "boomred");
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

// T14 of the 2026-10-21 fix round (bundesrat-cli fe0b46b): with the size cap lifted, a body of
// 512 MB and more can't become one string; V8's ERR_STRING_TOO_LONG escaped as a plain Error.
test("an answer longer than V8's longest string is an AwParseError naming the request, from either decode; an error status keeps its AwApiError (T14)", async (t) => {
  // A real one needs a body of 512 MB and more (possible with maxResponseBytes 0): V8's own
  // error is stood in for, for the bodies marked by their lengths. `valid` fails every decode;
  // `invalid` (a byte no UTF-8 has) fails the fatal one for real and the replacing one with the
  // stand-in.
  const valid = Buffer.from('{"meta":{},"data":[]}  ');
  const invalid = Buffer.concat([Buffer.from('{"meta":{},"data":["'), Buffer.from([0xff]), Buffer.from('"]}    ')]);
  assert.notEqual(valid.length, invalid.length);
  const tooLong = () => Object.assign(new Error("Cannot create a string longer than 0x1fffffe8 characters"), { code: "ERR_STRING_TOO_LONG" });
  const decode = TextDecoder.prototype.decode;
  t.mock.method(TextDecoder.prototype, "decode", function (this: InstanceType<typeof TextDecoder>, input?: Uint8Array, options?: { stream?: boolean }) {
    if (input?.byteLength === valid.length) throw tooLong();
    if (input?.byteLength === invalid.length && !this.fatal) throw tooLong();
    return decode.call(this, input, options);
  });
  const toString = Buffer.prototype.toString;
  t.mock.method(Buffer.prototype, "toString", function (this: Buffer, ...args: Parameters<Buffer["toString"]>) {
    if (this.length === valid.length && (args[0] === undefined || args[0] === "utf8")) throw tooLong();
    return toString.apply(this, args);
  });
  const on = (body: Buffer, status = 200) =>
    new RequestEngine({ maxResponseBytes: 0, transport: makeMockTransport(() => rawResponse(body, "application/json", status)).transport });
  for (const body of [valid, invalid]) {
    await assert.rejects(on(body).getJson("/api/v2/parties", { label: "x" }), (err: unknown) => {
      assert.ok(err instanceof AwParseError, String(err));
      assert.equal(
        err.message,
        `GET https://www.abgeordnetenwatch.de/api/v2/parties?label=x: the answer is too large to read as text (${body.length} bytes; the longest string is 536870888 characters).`,
      );
      return true;
    });
  }
  // An error status with such a body is still the API error, without the unreadable body.
  await assert.rejects(on(valid, 500).getJson("/api/v2/parties"), (err: unknown) => err instanceof AwApiError && err.status === 500 && err.body === "");
});

test("redactUrlUserinfo hides every URL's userinfo in one linear pass, however many URLs", () => {
  // The URL regex this replaces (a scheme tried at every word start) takes about 3 s on this.
  const started = performance.now();
  redactUrlUserinfo("a.".repeat(30_000));
  assert.ok(performance.now() - started < 1000);
  assert.equal(redactUrlUserinfo("a -https://u:p@h/x and x-ftp://v@w?q, mail@example.org"), "a -https://***@h/x and x-ftp://***@w?q, mail@example.org");
  assert.equal(redactUrlUserinfo("1://u:p@h ://u:p@h"), "1://u:p@h ://u:p@h");
  assert.equal(redactUrlUserinfo("https://h/p?u=a@b"), "https://h/p?u=a@b");
  for (const text of ["a".repeat(1_000_000), "a.".repeat(500_000), "://".repeat(100_000), `https://${"u".repeat(1_000_000)}`]) {
    assert.equal(redactUrlUserinfo(text), text);
  }
  const many = redactUrlUserinfo("https://u:p@h ".repeat(100_000));
  assert.equal(many, "https://***@h ".repeat(100_000));
});

function elapsed(work: () => unknown): number {
  const start = performance.now();
  work();
  return performance.now() - start;
}

test("redactUrlUserinfo hides the userinfo of a URL glued onto the one before it, still linear (B2)", () => {
  // The authority read for the first `://` ends at the `/` of the second; the second URL starts
  // inside it (its scheme is the first one's host, or follows a redacted `@`), so the search goes
  // on after each `://`, not after the authority. The regex this replaces redacted both; the
  // first linear pass missed them.
  assert.equal(redactUrlUserinfo("https://host://u:p@h"), "https://host://***@h");
  assert.equal(redactUrlUserinfo("https://u:p@x://v:q@w"), "https://***@x://***@w");
  assert.equal(redactUrlUserinfo("see https://h.example:/x://u:p@h"), "see https://h.example:/x://***@h");
  assert.equal(redactUrlUserinfo("https://u:p@1://v:q@w"), "https://***@1://v:q@w");
  // Many glued URLs, unredacted and redacted, and long scheme-character runs: one pass each.
  const n = 100_000;
  for (const [text, want] of [
    [`${"a://".repeat(n)}u:p@h`, `${"a://".repeat(n)}***@h`],
    ["x://u:p@".repeat(n), "x://***@".repeat(n)],
    [`${"a.".repeat(500_000)}://u:p@h`, `${"a.".repeat(500_000)}://***@h`],
    [`https://${"a.".repeat(500_000)}://u:p@h`, `https://${"a.".repeat(500_000)}://***@h`],
    ["a:".repeat(500_000), "a:".repeat(500_000)],
  ] as const) {
    let got = "";
    const ms = elapsed(() => (got = redactUrlUserinfo(text)));
    assert.ok(got === want, `${text.slice(0, 40)}…`);
    assert.ok(ms < 1000, `${Math.round(ms)} ms on ${text.slice(0, 40)}…`);
  }
});

test("a number with a long run of zeros is refused in linear time (A)", async () => {
  // decimalOf stripped trailing zeros with `/0+$/`, which tries a match at every zero of a run that
  // doesn't end the digits: 1.<100 000 zeros>1e300 took about 15 s, past any --timeout (the number
  // scan runs once the answer is in). Counted with index loops, it takes milliseconds.
  const body = `{"meta":{"status":"ok"},"data":{"id":1,"x":1.${"0".repeat(100_000)}1e300}}`;
  const e = new RequestEngine({ transport: async () => rawResponse(body, "application/json"), maxRetries: 0 });
  let err: unknown;
  const ms = await (async () => {
    const start = performance.now();
    err = await e.getJson("/x").catch((caught: unknown) => caught);
    return performance.now() - start;
  })();
  assert.ok(ms < 1000, `${Math.round(ms)} ms`);
  assert.ok(err instanceof AwParseError && /cannot be represented exactly/.test(err.message), String(err));
  assert.ok(err.message.length < 1000, "the message quotes the literal cut");
  // The same digits and exponent as before: trailing zeros of an integer past 2^53 are exact,
  // leading and trailing ones of a fraction too.
  assert.equal(firstInexactNumber(`[${"9".repeat(17)}0000, 1${"0".repeat(30)}, 0.000${"0".repeat(20)}]`), `${"9".repeat(17)}0000`);
  assert.equal(firstInexactNumber(`[1${"0".repeat(30)}, 12345678901234567000, 1.0e300, 0.00, -0]`), undefined);
});

test("sanitizeServerText drops whole escape sequences, not just their control bytes (C)", () => {
  const CSI8 = String.fromCharCode(0x9b);
  const OSC8 = String.fromCharCode(0x9d);
  const ST8 = String.fromCharCode(0x9c);
  for (const [input, expected] of [
    [`line1 ${ESC}]0;title${BEL}rest`, "line1 rest"],
    [`${ESC}]8;;https://evil.example${ESC}\\click${ESC}]8;;${ESC}\\`, "click"],
    [`${ESC}[31mred${ESC}[0m plain`, "red plain"],
    [`${ESC}[1;31;4mbold`, "bold"],
    [`${CSI8}2Jcleared`, "cleared"],
    [`${OSC8}0;t${ST8}ok`, "ok"],
    [`a${ESC}7b${ESC}(Bc`, "abc"],
    // Unterminated: only ESC and its introducer go, the text stays.
    [`keep ${ESC}]0;no terminator here`, "keep 0;no terminator here"],
  ] as const) {
    assert.equal(sanitizeServerText(input), expected, JSON.stringify(input));
  }
  // Invisible format characters and line breaks go too; ordinary text stays.
  assert.equal(sanitizeServerText("real\u200b error\u2028Error: forged\u2066x\u2069 \ufeffend\u00ad\u200d\u2060!"), "real error Error: forgedx end!");
  assert.equal(sanitizeServerText("  Cannot GET  /api/v2/x  Größe  "), "Cannot GET /api/v2/x Größe");
});

test("sanitizeServerText reads a bounded prefix and drops what the per-character filter dropped (C)", () => {
  // The filter it replaces, one character at a time: C0 but TAB to CR, DEL, C1 and Cf go.
  const perCharacter = (text: string): string =>
    [...text]
      .filter((ch) => {
        const n = ch.codePointAt(0) ?? 0;
        return (n >= 0x09 && n <= 0x0d) || !(n <= 0x1f || (n >= 0x7f && n <= 0x9f) || /\p{Cf}/u.test(ch));
      })
      .join("")
      .replace(/\s+/g, " ")
      .trim();
  const every = Array.from({ length: 0x3000 }, (_, i) => String.fromCharCode(i)).join("") + "\u{1f600}\u{e0001}\ud800x";
  for (let at = 0; at < every.length; at += 512) {
    const piece = every.slice(at, at + 512).replace(/[\u001b\u0090\u0098\u009b-\u009f]/g, "");
    assert.equal(sanitizeServerText(piece), perCharacter(piece), `from U+${at.toString(16)}`);
  }
  // At most 16 384 units of the text are read, never half a surrogate pair.
  assert.equal(sanitizeServerText("x".repeat(100_000)).length, 16_384);
  assert.equal(sanitizeServerText(`${"x".repeat(16_383)}\u{1f600}`), "x".repeat(16_383));
  // A control string ends at another introducer: the first is dropped by the filter, the second
  // string as a whole.
  const OSC8 = String.fromCharCode(0x9d);
  const ST8 = String.fromCharCode(0x9c);
  assert.equal(sanitizeServerText(`a${OSC8}0;x${OSC8}0;t${ST8}b`), "a0;xb");
  assert.equal(sanitizeServerText(`a${ESC}]0;x${ESC}]0;t${BEL}b`), "a0;xb");
  // An unterminated run of introducers is cleaned in linear time (100 000 × U+009D took 16 s).
  for (const opener of ["\u009d", "\u0090", "\u0098", "\u009e", "\u009f", "\u001b]"]) {
    const ms = elapsed(() => sanitizeServerText(`${opener.repeat(10_000)} tail`));
    assert.ok(ms < 200, `${JSON.stringify(opener)}: ${Math.round(ms)} ms`);
  }
});

test("a TextBuilder joins its pieces in order across batches (C)", () => {
  const b = new TextBuilder();
  const expected: string[] = [];
  for (let i = 0; i < 40_000; i++) {
    b.push(String(i), ",");
    expected.push(String(i), ",");
  }
  assert.equal(b.toString(), expected.join(""));
  assert.equal(new TextBuilder().toString(), "");
});

// These tests start a process with a small heap: 30 s instead of the suite's 5 s.
const STARTS_A_PROCESS = { timeout: 30_000 };

test("scanNumbers quotes millions of declared members within a small heap (C)", STARTS_A_PROCESS, () => {
  // One `+=` per quoted member made a rope node each: 3 million of them exhausted a 128 MB heap.
  const engine = new URL("../src/engine.js", import.meta.url).href;
  const n = 3_000_000;
  const script =
    `const { scanNumbers } = await import(${JSON.stringify(engine)});` +
    `const json = "[" + '{"k":1},'.repeat(${n - 1}) + '{"k":1}]';` +
    `process.stdout.write(String(scanNumbers(json, new Set(["k"])).json.length));`;
  const out = execFileSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(out, String(n * 10 + 1));
});

test("an answer of millions of lone surrogate escapes is repaired within a small heap (C)", STARTS_A_PROCESS, () => {
  // One `+=` per repair made a rope node each: 6 million of them exhausted a 128 MB heap.
  const engine = new URL("../src/engine.js", import.meta.url).href;
  const n = 6_000_000;
  const script =
    `const { RequestEngine } = await import(${JSON.stringify(engine)});` +
    `let body = Buffer.from('{"meta":{"status":"ok"},"data":{"x":"' + "\\\\ud800".repeat(${n}) + '"}}');` +
    `let warned = "";` +
    `const e = new RequestEngine({ transport: async () => { const b = body; body = undefined; return { status: 200, headers: { "content-type": "application/json" }, body: b }; }, onWarning: (m) => (warned = m) });` +
    `const value = await e.getJson("/x");` +
    `process.stdout.write(String(value.data.x.length) + " " + warned.includes("${n} characters"));`;
  const out = execFileSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(out, `${n} true`);
});

test("a credential echoed behind a JSON escape is scrubbed from the detail and the message (D)", async () => {
  // The body was scrubbed as sent, then decoded: `s3cret-pw` passed the scrub and JSON.parse
  // made it `s3cret-pw` in the detail and the message.
  const base = "https://alice:s3cret-pw@mirror.example";
  for (const json of ['"wrong password s3cret\\u002dpw"', '"bad login alice\\u003as3cret-pw"', '"\\u0073\\u0033cret-pw"']) {
    const e = new RequestEngine({ baseUrl: base, maxRetries: 0, transport: async () => rawResponse(`{"meta":{"status_message":${json}}}`, "application/json", 401) });
    const err = await e.getJson("/x").catch((caught: unknown) => caught);
    assert.ok(err instanceof AwApiError, String(err));
    for (const text of [err.message, err.detail ?? ""]) assert.ok(!text.includes("s3cret"), `${json}: ${text}`);
  }
});

test("an error body keeps its spelling unless a credential hides behind an escape (D)", async () => {
  const base = "https://alice:s3cret-pw@mirror.example";
  const bodyOf = async (body: string): Promise<string> => {
    const e = new RequestEngine({ baseUrl: base, maxRetries: 0, transport: async () => rawResponse(body, "application/json", 500) });
    const err = await e.getJson("/x").catch((caught: unknown) => caught);
    assert.ok(err instanceof AwApiError, String(err));
    return err.body;
  };
  // No credential, or one spelled as sent: the body as sent (scrubbed), escapes kept.
  assert.equal(await bodyOf('{"m":"caf\\u00e9 \\"x\\""}'), '{"m":"caf\\u00e9 \\"x\\""}');
  assert.equal(await bodyOf('{"m":"pw s3cret-pw \\u00e9"}'), '{"m":"pw *** \\u00e9"}');
  // Escaped: written again decoded, scrubbed in that spelling.
  assert.equal(await bodyOf('{"m":"pw s3cret\\u002dpw \\u00e9"}'), '{"m":"pw *** é"}');
  // Not JSON: nobody decodes it, it stays as sent.
  assert.equal(await bodyOf("pw s3cret\\u002dpw"), "pw s3cret\\u002dpw");
  // Deeply nested: written again where this runtime can, else left out (probed, not assumed:
  // whether JSON.stringify recurses depends on the Node version).
  const deep = `${"[".repeat(200_000)}"s3cret\\u002dpw"${"]".repeat(200_000)}`;
  let parses = true;
  let writes = true;
  try {
    const value: unknown = JSON.parse(deep);
    try {
      JSON.stringify(value);
    } catch {
      writes = false;
    }
  } catch {
    parses = false;
  }
  if (parses) {
    const body = await bodyOf(deep);
    assert.ok(!body.includes("s3cret"), body.slice(199_990, 200_030));
    assert.equal(body === "", !writes);
  }
});

test("a value quoted from an answer is scrubbed before it is cut, so no part of a credential stays (D)", () => {
  const pw = "s3cret-Pw-long";
  const e = new RequestEngine({ baseUrl: `https://alice:${pw}@mirror.example` });
  for (const at of [0, 490, 495, 499]) {
    const quoted = e.quoteServerValue(`${"x".repeat(at)}${pw}${"y".repeat(600)}`);
    assert.ok(!quoted.includes("s3cret"), `${at}: ${quoted}`);
  }
  // Cleaned like any server text, cut at 500 characters, or at the length given.
  assert.equal(new RequestEngine().quoteServerValue(`a${ESC}[31mb`), "ab");
  assert.equal(new RequestEngine().quoteServerValue("x".repeat(600)), `${"x".repeat(500)}…`);
  assert.equal(new RequestEngine().quoteServerValue("x".repeat(600), 200), `${"x".repeat(200)}…`);
});

test("an echo of the base URL as WHATWG spells it is scrubbed, a short password too (D)", async () => {
  // Typed raw; WHATWG writes `p%22%C3%A4` into the URL, which a proxy or server may echo.
  const e = new RequestEngine({
    baseUrl: 'https://alice:p"ä@mirror.example',
    maxRetries: 0,
    transport: async () => rawResponse(JSON.stringify({ message: "no access: https://alice:p%22%C3%A4@mirror.example/x" }), "application/json", 403),
  });
  const err = await e.getJson("/x").catch((caught: unknown) => caught);
  assert.ok(err instanceof AwApiError, String(err));
  for (const text of [err.message, err.detail ?? "", err.body]) {
    assert.ok(!text.includes("p%22%C3%A4@") && !text.includes('p"ä@'), text);
  }
});

test("a redirect whose Location echoes the base URL's credential is not followed, and the target is scrubbed (D2)", async () => {
  // Followed, the server's URL became the request URL that every later message names (`.url`,
  // `HTTP 302 for GET <url>`), with the credential in its query or path, percent-encoded in a
  // spelling the scrub did not know; and the credential went to wherever the Location pointed.
  const PW = "pä\"s's-W0rd";
  const base = `https://alice:${encodeURIComponent(PW)}@mirror.example`;
  const basic = Buffer.from(`alice:${PW}`, "utf8").toString("base64");
  const secrets = [PW, `alice:${PW}`, basic].flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)]);
  const decoded = (text: string): string =>
    text.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
  for (const location of [
    `https://elsewhere.example/login?user=alice&pw=${encodeURIComponent(PW)}`,
    `https://elsewhere.example/login?pw=${PW}`,
    `https://elsewhere.example/${encodeURIComponent(`alice:${PW}`)}/x`,
    `https://elsewhere.example/auth?basic=${basic}`,
    `/relative/${PW}`,
  ]) {
    const mt = makeMockTransport(() => redirectResponse(location));
    const e = new RequestEngine({ baseUrl: base, transport: mt.transport, maxRetries: 0 });
    const err = await e.getJson("/x").catch((caught: unknown) => caught);
    assert.ok(err instanceof AwApiError && err.status === 302, String(err));
    assert.equal(mt.calls.length, 1, `${location}: followed`);
    assert.match(err.message, /redirect to \S+ not followed/);
    const seen = decoded([err.message, err.url, err.location ?? "", err.detail ?? ""].join("\n"));
    for (const secret of secrets) assert.ok(!seen.includes(secret), `${location}: ${seen}`);
  }
  // Without credentials, or a Location that echoes none, the redirect is followed as before.
  const plain = makeMockTransport((req) => (req.url.includes("/next") ? jsonResponse({ ok: 1 }) : redirectResponse(`/next?pw=${PW}`)));
  assert.deepEqual(await new RequestEngine({ transport: plain.transport }).getJson("/x"), { ok: 1 });
  const other = makeMockTransport((req) => (req.url.includes("/next") ? jsonResponse({ ok: 1 }) : redirectResponse("/next?pw=other")));
  assert.deepEqual(await new RequestEngine({ baseUrl: base, transport: other.transport }).getJson("/x"), { ok: 1 });
});

test("echoedCredentialForms treats a userinfo without a password as a token (Basic `TOKEN:`) (E)", () => {
  const basic = (pair: string): string => Buffer.from(pair, "utf8").toString("base64");
  assert.deepEqual(echoedCredentialForms("alice:s3cret"), [basic("alice:s3cret"), "alice:s3cret", "s3cret"]);
  assert.deepEqual(echoedCredentialForms("T0ken"), [basic("T0ken:"), "T0ken:", "T0ken"]);
  assert.deepEqual(echoedCredentialForms("T0ken:"), [basic("T0ken:"), "T0ken:", "T0ken"]);
  assert.deepEqual(echoedCredentialForms("T%C3%B6k"), [basic("Tök:"), "Tök:"]); // short: not alone
  assert.deepEqual(echoedCredentialForms(":pw12"), [basic(":pw12"), ":pw12", "pw12"]);
  assert.deepEqual(echoedCredentialForms(""), []);
  assert.deepEqual(echoedCredentialForms(":"), []);
});

test("a token in the base URL (userinfo without a password) is scrubbed from errors in every echoed form (E)", async () => {
  // Node sends `https://T0kenS3cret@host` as Basic `T0kenS3cret:`; none of its forms was scrubbed.
  const token = "T0kenS3cret";
  const basic = Buffer.from(`${token}:`, "utf8").toString("base64");
  for (const base of [`https://${token}@mirror.example`, `https://${token}:@mirror.example`]) {
    for (const echo of [`bad token ${token}`, `Authorization: Basic ${basic}`, `user ${token}: unknown`]) {
      const e = new RequestEngine({ baseUrl: base, maxRetries: 0, transport: async () => apiErrorBody(echo, 401) });
      const err = await e.getJson("/x").catch((caught: unknown) => caught);
      assert.ok(err instanceof AwApiError, String(err));
      for (const text of [err.message, err.detail ?? "", err.body]) {
        assert.ok(!text.includes(token) && !text.includes(basic), `${base} ${echo}: ${text}`);
      }
    }
  }
});
