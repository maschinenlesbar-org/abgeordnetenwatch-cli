import { test } from "node:test";
import assert from "node:assert/strict";
import { AbgeordnetenwatchClient } from "../src/client/client.js";
import { MAX_RETRY_AFTER_MS, parseRetryAfter } from "../src/client/engine.js";
import { AwApiError, AwError, AwNetworkError, AwParseError, redactUrl } from "../src/client/errors.js";
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

test("list() and count() options win over a filter with the same wire name", async () => {
  const mt = makeMockTransport(() => jsonResponse(listEnvelope([], 7)));
  const client = new AbgeordnetenwatchClient({ transport: mt.transport });

  await client.list("parties", {
    rangeEnd: 3,
    sortDirection: "asc",
    filters: { range_end: 5000, sort_direction: "sideways", sex: "f" },
  });
  const url = new URL(mt.last().url);
  assert.deepEqual(url.searchParams.getAll("range_end"), ["3"]);
  assert.deepEqual(url.searchParams.getAll("sort_direction"), ["asc"]);
  assert.equal(url.searchParams.get("sex"), "f");

  assert.equal(await client.count("parties", { filters: { range_end: 50 } }), 7);
  assert.deepEqual(new URL(mt.last().url).searchParams.getAll("range_end"), ["1"]);
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
        err instanceof AwNetworkError && /Base URL must not contain a query or fragment/.test(err.message),
      baseUrl,
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
    (e: unknown) => e instanceof AwNetworkError && !e.message.includes("u:p") && e.message.includes("***@"),
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
