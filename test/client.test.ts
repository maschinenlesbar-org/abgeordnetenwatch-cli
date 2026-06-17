import { test } from "node:test";
import assert from "node:assert/strict";
import { AbgeordnetenwatchClient } from "../src/client/client.js";
import { AwApiError, AwParseError } from "../src/client/errors.js";
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

test("a non-JSON 2xx body raises AwParseError", async () => {
  const mt = makeMockTransport(() => rawResponse("<html>not json</html>", "text/html"));
  const client = new AbgeordnetenwatchClient({ transport: mt.transport });
  await assert.rejects(() => client.list("politicians"), AwParseError);
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
