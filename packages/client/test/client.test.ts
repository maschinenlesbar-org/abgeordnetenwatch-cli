import { test } from "node:test";
import assert from "node:assert/strict";
import { AbgeordnetenwatchClient } from "../src/client.js";
import { MAX_RETRY_AFTER_MS, isTransientNetworkError, parseRetryAfter } from "../src/engine.js";
import type { HttpResponse } from "../src/http.js";
import {
  AwApiError,
  AwError,
  AwNetworkError,
  AwParseError,
  AwValidationError,
  redactUrl,
} from "../src/errors.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";

const listEnvelope = (data: unknown[], total = data.length) => ({
  meta: {
    abgeordnetenwatch_api: { version: "2.9.0" },
    status: "ok",
    status_message: "",
    result: { count: data.length, total, range_start: 0, range_end: data.length },
  },
  data,
});

const detailEnvelope = (data: unknown) => ({
  meta: {
    abgeordnetenwatch_api: { version: "2.9.0" },
    status: "ok",
    status_message: "",
    result: { entity_id: "1", entity_type: "politician" },
  },
  data,
});

test("list() hits the collection path and returns the envelope", async () => {
  const mt = makeMockTransport(() => jsonResponse(listEnvelope([{ id: 1 }, { id: 2 }])));
  const client = new AbgeordnetenwatchClient({ transport: mt.transport });

  const res = await client.list("politicians");
  assert.equal(res.data.length, 2);
  assert.equal(res.meta.result.total, 2);
  assert.match(mt.last().url, /\/api\/v2\/politicians$/);
});

test("list() maps params and filters into the query string", async () => {
  const mt = makeMockTransport(() => jsonResponse(listEnvelope([])));
  const client = new AbgeordnetenwatchClient({ transport: mt.transport });

  await client.list("politicians", {
    rangeStart: 10,
    rangeEnd: 5,
    sortBy: "last_name",
    sortDirection: "desc",
    filters: { sex: "f", "year_of_birth[gt]": 1990 },
  });

  const url = mt.last().url;
  assert.match(url, /range_start=10/);
  assert.match(url, /range_end=5/);
  assert.match(url, /sort_by=last_name/);
  assert.match(url, /sort_direction=desc/);
  assert.match(url, /sex=f/);
  // brackets are percent-encoded
  assert.match(url, /year_of_birth%5Bgt%5D=1990/);
});

test("list() and count() reject a filter named like a paging or sort option, before any request", async () => {
  const mt = makeMockTransport(() => jsonResponse(listEnvelope([], 7)));
  const client = new AbgeordnetenwatchClient({ transport: mt.transport });

  await assert.rejects(
    client.list("parties", { rangeEnd: 3, filters: { range_end: 5000, sex: "f" } }),
    (err: unknown) =>
      err instanceof AwValidationError &&
      err.message === 'Invalid filter "range_end": "range_end" is a paging or sorting parameter, not a filter.',
  );
  await assert.rejects(client.count("parties", { filters: { range_end: 50 } }), AwValidationError);
  assert.equal(mt.calls.length, 0);
});

test("an unknown collection is rejected before any request (no path escape)", async () => {
  const mt = makeMockTransport(() => jsonResponse(listEnvelope([])));
  const client = new AbgeordnetenwatchClient({ transport: mt.transport });
  for (const name of ["../../esc", "parties?x=1", "parties/../politicians", ""]) {
    const collection = name as unknown as "parties";
    for (const call of [() => client.list(collection), () => client.get(collection, 1), () => client.count(collection)]) {
      await assert.rejects(call, (e: unknown) => e instanceof AwError && /Unknown collection/.test(e.message), name);
    }
  }
  assert.equal(mt.calls.length, 0);
});

test("get() requests the id sub-path and returns the object", async () => {
  const mt = makeMockTransport(() => jsonResponse(detailEnvelope({ id: 42, label: "X" })));
  const client = new AbgeordnetenwatchClient({ transport: mt.transport });

  const res = await client.get("parties", 42);
  assert.equal((res.data as { id: number }).id, 42);
  assert.match(mt.last().url, /\/api\/v2\/parties\/42$/);
});

test("count() asks for range_end=1 and reads meta.result.total", async () => {
  const mt = makeMockTransport(() => jsonResponse(listEnvelope([{ id: 1 }], 9619)));
  const client = new AbgeordnetenwatchClient({ transport: mt.transport });

  const total = await client.count("politicians", { filters: { sex: "f" } });
  assert.equal(total, 9619);
  assert.match(mt.last().url, /range_end=1/);
  assert.match(mt.last().url, /sex=f/);
});

test("a 404 surfaces as AwApiError carrying the API status_message", async () => {
  const body = {
    meta: { status: "error", status_message: "There is no party entity with id 99999999" },
  };
  const mt = makeMockTransport(() => jsonResponse(body, 404));
  const client = new AbgeordnetenwatchClient({ transport: mt.transport });

  await assert.rejects(
    () => client.get("parties", 99999999),
    (err: unknown) => {
      assert.ok(err instanceof AwApiError);
      assert.equal(err.status, 404);
      assert.match(err.message, /no party entity with id 99999999/);
      return true;
    },
  );
});

test("rejects a non-http base URL with a message naming it", () => {
  assert.throws(
    () => new AbgeordnetenwatchClient({ baseUrl: "ftp://example.com" }),
    (err: unknown) => {
      assert.ok(err instanceof AwError);
      assert.match(err.message, /ftp:/);
      assert.match(err.message, /example\.com/);
      return true;
    },
  );
});

test("a base URL with a query or fragment is rejected at construction", () => {
  for (const baseUrl of ["https://example.test/?x=1", "https://example.test/#frag", "https://example.test?"]) {
    assert.throws(
      () => new AbgeordnetenwatchClient({ baseUrl }),
      (err: unknown) =>
        err instanceof AwValidationError &&
        !(err instanceof AwNetworkError) &&
        err.message === `Invalid base URL "${baseUrl}": A base URL cannot have a query (?) or fragment (#).`,
      baseUrl,
    );
  }
});

test("a base URL with surrounding whitespace is rejected at construction, before the slash strip", () => {
  for (const baseUrl of ["https://example.test/ ", " https://example.test", "https://example.test//\n"]) {
    assert.throws(
      () => new AbgeordnetenwatchClient({ baseUrl }),
      (err: unknown) =>
        err instanceof AwValidationError &&
        err.message === `Invalid base URL "${baseUrl}": A base URL cannot have surrounding whitespace.`,
      JSON.stringify(baseUrl),
    );
  }
});

test("redactUrl hides userinfo and leaves other URLs alone", () => {
  assert.equal(redactUrl("https://u:p@example.test/a?b=1"), "https://***@example.test/a?b=1");
  assert.equal(redactUrl("https://token@example.test/"), "https://***@example.test/");
  assert.equal(redactUrl("https://example.test/a b"), "https://example.test/a b");
  assert.equal(redactUrl("not a url"), "not a url");
  const err = new AwApiError({ status: 500, url: "https://u:p@example.test/x", method: "GET", body: "" });
  assert.equal(err.url, "https://***@example.test/x");
  assert.ok(!err.message.includes("u:p"));
  assert.throws(
    () => new AbgeordnetenwatchClient({ baseUrl: "https://u:p@example.test/?x" }),
    (e: unknown) => e instanceof AwValidationError && !e.message.includes("u:p") && e.message.includes("***@"),
  );
});

test("numeric engine options must be integers in range; a bad one throws instead of disabling a limit", () => {
  const bad: [string, number][] = [
    ["timeoutMs", -5],
    ["timeoutMs", Number.NaN],
    ["timeoutMs", 1.5],
    ["timeoutMs", 2_147_483_648],
    ["maxRetries", -1],
    ["maxRetries", Number.POSITIVE_INFINITY],
    ["maxRetries", 11],
    ["retryDelayMs", -1],
    ["retryDelayMs", 30_001],
    ["maxRedirects", -1],
    ["maxRedirects", Number.NaN],
    ["maxRedirects", 21],
    ["maxResponseBytes", -1],
    ["maxResponseBytes", 0.5],
  ];
  for (const [name, value] of bad) {
    assert.throws(
      () => new AbgeordnetenwatchClient({ [name]: value }),
      (e: unknown) =>
        e instanceof AwError && new RegExp(`^Invalid option ${name}: expected an integer from 0 to \\d+, got `).test(e.message),
      `${name}=${value}`,
    );
  }
  for (const [name, value] of [
    ["timeoutMs", 0],
    ["timeoutMs", 2_147_483_647],
    ["maxRetries", 10],
    ["retryDelayMs", 0],
    ["maxRedirects", 0],
    ["maxResponseBytes", 0],
  ] as const) {
    assert.doesNotThrow(() => new AbgeordnetenwatchClient({ [name]: value }), `${name}=${value}`);
  }
});

test("the body is decoded by its charset, and a UTF-8 byte-order mark is ignored", async () => {
  const env = detailEnvelope({ id: 1, label: "Müller" });
  const json = JSON.stringify(env);
  for (const [name, body, type] of [
    ["latin1", Buffer.from(json, "latin1"), "application/json; charset=iso-8859-1"],
    ["quoted", Buffer.from(json, "latin1"), 'application/json; charset="ISO-8859-1"'],
    ["bom", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json)]), "application/json"],
    ["utf8", Buffer.from(json), "application/json; charset=utf-8"],
  ] as const) {
    const mt = makeMockTransport(() => rawResponse(body, type));
    const client = new AbgeordnetenwatchClient({ transport: mt.transport });
    assert.deepEqual(await client.get("parties", 1), env, name);
  }
  const mt = makeMockTransport(() => rawResponse(json, "application/json; charset=x-nonsense"));
  const client = new AbgeordnetenwatchClient({ transport: mt.transport });
  await assert.rejects(
    () => client.get("parties", 1),
    (e: unknown) => e instanceof AwParseError && /Unsupported response charset "x-nonsense"/.test(e.message),
  );
});

test("a non-JSON 2xx body raises AwParseError", async () => {
  const mt = makeMockTransport(() => rawResponse("<html>not json</html>", "text/html"));
  const client = new AbgeordnetenwatchClient({ transport: mt.transport });
  await assert.rejects(() => client.list("politicians"), AwParseError);
});

test("a 2xx body that is not a { meta, data } envelope raises AwParseError", async () => {
  const cases: [string, unknown, (c: AbgeordnetenwatchClient) => Promise<unknown>, RegExp][] = [
    ["null body", null, (c) => c.list("parties"), /expected a JSON object with meta and data/],
    ["array body", [1, 2], (c) => c.list("parties"), /expected a JSON object with meta and data/],
    ["no meta", { data: [] }, (c) => c.list("parties"), /expected a JSON object with meta and data/],
    ["list without data", { meta: {} }, (c) => c.list("parties"), /expected a data array/],
    ["list with an object", detailEnvelope({ id: 1 }), (c) => c.list("parties"), /expected a data array/],
    ["get with a list", listEnvelope([]), (c) => c.get("parties", 5), /expected a data object/],
    ["get with null data", detailEnvelope(null), (c) => c.get("parties", 5), /expected a data object/],
    ["count without result", { meta: {}, data: [] }, (c) => c.count("parties"), /numeric meta\.result\.total/],
  ];
  for (const [name, body, call, message] of cases) {
    const mt = makeMockTransport(() => jsonResponse(body));
    const client = new AbgeordnetenwatchClient({ transport: mt.transport });
    await assert.rejects(
      () => call(client),
      (err: unknown) =>
        err instanceof AwParseError && /^Unexpected response shape from \/api\/v2\/parties/.test(err.message) &&
        message.test(err.message),
      name,
    );
  }
});

test("count() rejects a total that is not a non-negative integer", async () => {
  for (const total of ["9", -1, 1.5, null]) {
    const env = listEnvelope([]);
    const mt = makeMockTransport(() =>
      jsonResponse({ ...env, meta: { ...env.meta, result: { ...env.meta.result, total } } }),
    );
    const client = new AbgeordnetenwatchClient({ transport: mt.transport });
    await assert.rejects(() => client.count("parties"), AwParseError, String(total));
  }
});

test("retries a 429 then succeeds", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1 ? jsonResponse({}, 429) : jsonResponse(listEnvelope([{ id: 1 }]));
  });
  const client = new AbgeordnetenwatchClient({
    transport: mt.transport,
    sleep: async () => {},
  });
  const res = await client.list("votes");
  assert.equal(res.data.length, 1);
  assert.equal(calls, 2);
});

test("honours a numeric Retry-After header (seconds) on 429", async () => {
  const delays: number[] = [];
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1
      ? { status: 429, headers: { "retry-after": "2" }, body: Buffer.alloc(0) }
      : jsonResponse(listEnvelope([{ id: 1 }]));
  });
  const client = new AbgeordnetenwatchClient({
    transport: mt.transport,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  await client.list("votes");
  assert.deepEqual(delays, [2000]); // 2s from the header, not the linear backoff
});

test("a Retry-After beyond 30 s is not retried: the error surfaces at once", async () => {
  for (const header of ["31", "99999999999999999999", "Wed, 21 Oct 2099 07:28:00 GMT"]) {
    const delays: number[] = [];
    const mt = makeMockTransport(() => ({ status: 503, headers: { "retry-after": header }, body: Buffer.alloc(0) }));
    const client = new AbgeordnetenwatchClient({
      transport: mt.transport,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    await assert.rejects(() => client.list("votes"), (e: unknown) => e instanceof AwApiError && e.status === 503);
    assert.equal(mt.calls.length, 1, header);
    assert.deepEqual(delays, [], header);
  }
});

test("a malformed Retry-After (-1, 1.5, ...) falls back to the linear backoff", async () => {
  for (const header of ["", "-1", "1.5", "+5", "soon", "1e3", "0x10", "2026-09-26T10:00:00Z"]) {
    const delays: number[] = [];
    const mt = makeMockTransport(() => ({ status: 429, headers: { "retry-after": header }, body: Buffer.alloc(0) }));
    const client = new AbgeordnetenwatchClient({
      transport: mt.transport,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    await assert.rejects(() => client.list("votes"), AwApiError);
    assert.deepEqual(delays, [1000, 2000], header);
  }
});

test("parseRetryAfter reads delay-seconds and IMF-fixdate HTTP-dates", () => {
  const now = Date.parse("Sat, 26 Sep 2026 10:00:00 GMT");
  assert.equal(parseRetryAfter("0", now), 0);
  assert.equal(parseRetryAfter(" 30 ", now), 30_000);
  assert.equal(parseRetryAfter(["2", "9"], now), 2000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 10:00:05 GMT", now), 5000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 09:00:00 GMT", now), 0); // past date: retry now
  for (const bad of [undefined, "", "-1", "+5", "1.5", "1e3", "0x10", "Saturday, 26-Sep-26 10:00:05 GMT"]) {
    assert.equal(parseRetryAfter(bad, now), undefined, String(bad));
  }
  assert.equal(MAX_RETRY_AFTER_MS, 30_000);
});

test("the default backoff without Retry-After (1 s, 2 s) outlasts the API's rate-limit window", async () => {
  const delays: number[] = [];
  const mt = makeMockTransport(() => jsonResponse({}, 429));
  const client = new AbgeordnetenwatchClient({
    transport: mt.transport,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  await assert.rejects(() => client.list("votes"), AwApiError);
  assert.equal(mt.calls.length, 3);
  assert.deepEqual(delays, [1000, 2000]);
});

test("falls back to linear backoff when no Retry-After is present", async () => {
  const delays: number[] = [];
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls < 3 ? jsonResponse({}, 429) : jsonResponse(listEnvelope([{ id: 1 }]));
  });
  const client = new AbgeordnetenwatchClient({
    transport: mt.transport,
    sleep: async (ms) => {
      delays.push(ms);
    },
    maxRetries: 2,
    retryDelayMs: 200,
  });
  await client.list("votes");
  assert.deepEqual(delays, [200, 400]);
});

test("only 429 and 503 are retried: a 500, 502 or 504 is asked once", async () => {
  // The API answers a missing id and an invalid filter with HTTP 500; retrying it would
  // repeat every such mistake against the live service and make the user wait for it.
  for (const [status, body] of [
    [500, { meta: { status: "error", status_message: "The following parameter(s) are not valid: x" } }],
    [500, {}],
    [502, {}],
    [504, {}],
  ] as const) {
    const sleeps: number[] = [];
    const mt = makeMockTransport(() => jsonResponse(body, status));
    const client = new AbgeordnetenwatchClient({
      transport: mt.transport,
      maxRetries: 2,
      sleep: async (ms) => void sleeps.push(ms),
    });
    await assert.rejects(client.list("votes"), (err) => err instanceof AwApiError && err.status === status, String(status));
    assert.equal(mt.calls.length, 1, `HTTP ${status} was retried`);
    assert.deepEqual(sleeps, [], `HTTP ${status} waited`);
  }
});

test("a refused connection, a DNS failure and a timeout are not retried", async () => {
  // Only a reset connection is the network-level twin of a 503 (DEVELOPING.md); asking a
  // server that refused or a name that does not resolve again only delays the error.
  for (const [label, thrown] of [
    ["ECONNREFUSED", Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" })],
    ["ENOTFOUND", Object.assign(new Error("getaddrinfo ENOTFOUND nowhere.invalid"), { code: "ENOTFOUND" })],
    ["timeout", new AwNetworkError("Request timed out after 10ms")],
  ] as const) {
    let calls = 0;
    const client = new AbgeordnetenwatchClient({
      transport: async () => {
        calls += 1;
        throw thrown;
      },
      maxRetries: 2,
      sleep: async () => {},
    });
    await assert.rejects(client.list("votes"), AwNetworkError, label);
    assert.equal(calls, 1, `${label} was retried`);
  }
});

test("a timeout, the size cap and a refused connection name the request (bug 3, 2026-10-20)", async () => {
  // They said only "Request timed out after 500ms", "Response exceeded the size limit of 10
  // bytes (…)" and "connect ECONNREFUSED 127.0.0.1:1", where a reset says "GET <url> failed: …".
  const url = "http://127.0.0.1:9/api/v2/parties/1";
  const cases: Array<[string, ConstructorParameters<typeof AbgeordnetenwatchClient>[0], RegExp]> = [
    ["engine deadline", { transport: () => new Promise<HttpResponse>(() => {}), timeoutMs: 20 }, /^Request timed out after 20ms$/],
    ["transport's own timeout", { transport: async () => { throw new AwNetworkError("Request timed out after 500ms"); } }, /^Request timed out after 500ms$/],
    ["transport's size cap", { transport: async () => { throw new AwNetworkError("Response exceeded the size limit of 10 bytes (maxResponseBytes; --max-response-bytes on the CLI)"); } }, /^Response exceeded the size limit of 10 bytes/],
    ["refused", { transport: async () => { throw new AwNetworkError("connect ECONNREFUSED 127.0.0.1:9"); } }, /^connect ECONNREFUSED 127\.0\.0\.1:9$/],
  ];
  for (const [name, options, reason] of cases) {
    const client = new AbgeordnetenwatchClient({ baseUrl: "http://127.0.0.1:9", maxRetries: 0, ...options });
    await assert.rejects(client.get("parties", 1), (err) => {
      assert.ok(err instanceof AwNetworkError, name);
      assert.ok(err.message.startsWith(`GET ${url} failed: `), `${name}: ${err.message}`);
      assert.match(err.message.slice(`GET ${url} failed: `.length), reason, name);
      return true;
    });
  }
  // A message that names the request already is not prefixed twice.
  const named = new AbgeordnetenwatchClient({ baseUrl: "http://127.0.0.1:9", transport: async () => { throw new AwNetworkError(`GET ${url} failed: x`); } });
  await assert.rejects(named.get("parties", 1), { message: `GET ${url} failed: x` });
});

test("an error message cuts a very long URL in the middle and says how long it was", () => {
  const url = `https://www.abgeordnetenwatch.de/api/v2/politicians?${"label[cn]=x&".repeat(30)}end=1`;
  const err = new AwApiError({ status: 500, url, method: "GET", body: "" });
  assert.equal(
    err.message,
    "HTTP 500 for GET https://www.abgeordnetenwatch.de/api/v2/politicians?" +
      "label[cn]=x&label[cn]=x&label[cn]=x&label[cn]=x&label[cn]=x&label[cn]=x&label[cn]=x&label[cn]=x&label[cn]=x&" +
      "…[417 chars]…=x&label[cn]=x&end=1",
  );
  assert.equal(err.url, url, "the full URL stays on the error");
});

test("a reset connection that outlasts the retries names the request and the retries", async () => {
  // The default transport rejects a reset with a bare "socket hang up" (the Node error is its
  // cause). Rethrown as it was, the final error named neither the host nor the retries, unlike
  // a 429/503 (exploratory 2026-10-15, bug 4).
  const reset = () => new AwNetworkError("socket hang up", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
  for (const [maxRetries, suffix] of [[0, ""], [1, " (after 1 retry)"], [2, " (after 2 retries)"]] as const) {
    let calls = 0;
    const client = new AbgeordnetenwatchClient({
      baseUrl: "http://127.0.0.1:9",
      transport: async () => {
        calls += 1;
        throw reset();
      },
      maxRetries,
      sleep: async () => {},
    });
    await assert.rejects(client.list("votes", { filters: { poll: 1 } }), (err) => {
      assert.ok(err instanceof AwNetworkError);
      assert.equal(err.message, `GET http://127.0.0.1:9/api/v2/votes?poll=1 failed: socket hang up${suffix}`);
      assert.ok(isTransientNetworkError(err), "still recognisable as a reset");
      return true;
    });
    assert.equal(calls, maxRetries + 1);
  }
});

test("a filter value in decomposed Unicode is sent composed (NFC)", async () => {
  // The API matches composed text only: "Müller" with U+0308 counted 0 politicians where the
  // composed form counted 280 (exploratory 2026-10-15, bug 1). Text pasted from macOS file
  // names or some PDFs arrives decomposed.
  const mt = makeMockTransport(() => jsonResponse(listEnvelope([], 280)));
  const client = new AbgeordnetenwatchClient({ transport: mt.transport });
  assert.equal(await client.count("politicians", { filters: { "last_name[eq]": "Müller", year_of_birth: 1980 } }), 280);
  const query = new URL(mt.last().url).searchParams;
  assert.equal(query.get("last_name[eq]"), "Müller");
  assert.equal(query.get("year_of_birth"), "1980");
});

test("a filter value is sent without surrounding whitespace (bug 7, 2026-10-20)", async () => {
  // The API does not trim: "last_name=Scholz " counted 0 where "Scholz" counted 31, and
  // "first_name=Olaf " found nobody, with exit 0. A value pasted from a spreadsheet or a shell
  // variable often carries a trailing space.
  const mt = makeMockTransport(() => jsonResponse(listEnvelope([], 31)));
  const client = new AbgeordnetenwatchClient({ transport: mt.transport });
  await client.count("politicians", { filters: { last_name: "  Scholz  ", first_name: "Olaf\t", "label[cn]": "\u00a0Olaf Scholz\n", "field_title[sw]": " Mu\u0308 ", year_of_birth: 1958 } });
  const query = new URL(mt.last().url).searchParams;
  assert.equal(query.get("last_name"), "Scholz");
  assert.equal(query.get("first_name"), "Olaf");
  assert.equal(query.get("label[cn]"), "Olaf Scholz", "inner spaces stay");
  assert.equal(query.get("field_title[sw]"), "Mü", "trimmed and composed");
  assert.equal(query.get("year_of_birth"), "1958");
});

test("an HTTP 200 envelope with meta.status other than ok rejects with its message (bug 2, 2026-10-15)", async () => {
  // count() resolved to 0 and list() to [] for an answer that said it had failed.
  const errorMeta = { status: "error", status_message: "Database \u001b[31munavailable", result: { count: 0, total: 0, range_start: 0, range_end: 1 } };
  const mt = makeMockTransport((req) =>
    jsonResponse({ meta: errorMeta, data: new URL(req.url).pathname.endsWith("/5") ? {} : [] }),
  );
  const client = new AbgeordnetenwatchClient({ transport: mt.transport });
  for (const [label, call, path] of [
    ["count", () => client.count("politicians"), "/api/v2/politicians"],
    ["list", () => client.list("politicians"), "/api/v2/politicians"],
    ["get", () => client.get("parties", 5), "/api/v2/parties/5"],
  ] as const) {
    await assert.rejects(call(), (err) => {
      assert.ok(err instanceof AwParseError, label);
      // The server's text is cleaned of control characters, like an error status's detail.
      assert.equal(err.message, `Error envelope in a 2xx answer from ${path}: Database [31munavailable`, label);
      return true;
    });
  }
  // Without a message the status itself is named; an envelope without a status is still data.
  const bare = makeMockTransport(() => jsonResponse({ meta: { status: "failed" }, data: [] }));
  await assert.rejects(new AbgeordnetenwatchClient({ transport: bare.transport }).list("parties"), /Error envelope in a 2xx answer from \/api\/v2\/parties: meta\.status "failed"$/);
  const noStatus = makeMockTransport(() => jsonResponse({ meta: {}, data: [] }));
  assert.deepEqual((await new AbgeordnetenwatchClient({ transport: noStatus.transport }).list("parties")).data, []);
});

test("a number the answer's JSON cannot carry exactly is a parse error, never a changed value (bug 3, 2026-10-15)", async () => {
  // JSON.parse rounded 12345678901234567890 to 12345678901234567000 and turned 1e400 into
  // Infinity, which printed as null, with exit 0.
  const body = (n: string) => `{"meta":{"status":"ok","result":{"entity_id":"1"}},"data":{"id":1,"amount":${n}}}`;
  for (const n of ["12345678901234567890", "-9007199254740993", "1e400", "-1e400"]) {
    const mt = makeMockTransport(() => rawResponse(body(n), "application/json"));
    await assert.rejects(new AbgeordnetenwatchClient({ transport: mt.transport }).get("parties", 1), (err) => {
      assert.ok(err instanceof AwParseError, n);
      assert.equal(err.message, `Unexpected response from /api/v2/parties/1: the number ${n} cannot be represented exactly.`);
      return true;
    });
  }
  // What a double carries exactly (or as JSON means it) passes unchanged.
  for (const [n, value] of [["9007199254740991", 9007199254740991], ["-9007199254740992", -9007199254740992], ["1.10", 1.1], ["0.1", 0.1], ["1e21", 1e21], ["-0", -0]] as const) {
    const mt = makeMockTransport(() => rawResponse(body(n), "application/json"));
    const res = await new AbgeordnetenwatchClient({ transport: mt.transport }).get("parties", 1);
    assert.equal(res.data["amount"], value, n);
  }
});

test("a big number written as a decimal or an exponent, a fraction past 2^53 and an underflow are parse errors too (bug 1, 2026-10-20)", async () => {
  // These passed the check and printed 12345678901234567000, 9007199254740992 and 0, exit 0.
  const body = (n: string) => `{"meta":{"status":"ok","result":{"entity_id":"1"}},"data":{"id":1,"amount":${n}}}`;
  for (const n of ["12345678901234567890.0", "9007199254740993e0", "90071992547409930E-1", "9007199254740992.5", "-9007199254740992.5", "1e-400", "-0.0001e-399", "1e23"]) {
    const mt = makeMockTransport(() => rawResponse(body(n), "application/json"));
    await assert.rejects(new AbgeordnetenwatchClient({ transport: mt.transport }).get("parties", 1), (err) => {
      assert.ok(err instanceof AwParseError, n);
      assert.equal(err.message, `Unexpected response from /api/v2/parties/1: the number ${n} cannot be represented exactly.`);
      return true;
    });
  }
  // The same values in other forms, zero in any form, and a decimal fraction below 2^53 pass.
  const ok: Array<[string, number]> = [
    ["9007199254740992.0", 2 ** 53], ["9007199254740992e0", 2 ** 53], ["90071992547409920E-1", 2 ** 53], ["1.2e21", 1.2e21],
    ["0", 0], ["0.0e-500", 0], ["0e5", 0], ["1.00000000000000001", 1], ["5e-324", 5e-324], ["1e2", 100],
  ];
  for (const [n, value] of ok) {
    const mt = makeMockTransport(() => rawResponse(body(n), "application/json"));
    const res = await new AbgeordnetenwatchClient({ transport: mt.transport }).get("parties", 1);
    assert.equal(res.data["amount"], value, n);
  }
});
