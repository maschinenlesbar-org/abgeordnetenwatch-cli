// Conformance test P10 (fix plan 2026-10-06): a filter the API would ignore never goes out.
// An unknown, misspelled or `__proto__` key, an unknown filter name, an array or NaN where
// the API takes one value are the library's validation error before any data request; a
// filter name that is only spelled differently (NFD, padding, case) is normalised or
// rejected, never sent as typed; a repeated filter flag is combined or rejected, never
// "last one wins". The API answers all of these with the whole unfiltered set or a wrong
// count and HTTP 200. Shared across the *-cli repos with filters; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { run } from "../src/cli/run.js";
import { AbgeordnetenwatchClient as Client } from "../src/client/client.js";
import { AwValidationError as ValidationError } from "../src/client/errors.js";
/** The library's filtered call, with its query/parameter object passed through as is. */
const call = (client: Client, query: Record<string, unknown>): Promise<unknown> =>
  client.list("politicians", query as never);
/** A valid query, and the filter it sends (read back from the request by `sentFilter`). */
const GOOD = { query: { filters: { sex: "f", "year_of_birth[gt]": 1990 } } };
const GOOD_SENT = "sex=f&year_of_birth[gt]=1990";
/** What a data request carries as its filters: every parameter but paging and sorting. */
const sentFilter = (req: HttpRequest): string | null => {
  const pairs = [...new URL(req.url).searchParams].filter(([k]) => !/^(range_start|range_end|sort_by|sort_direction)$/.test(k));
  return pairs.length === 0 ? null : pairs.map(([k, v]) => `${k}=${v}`).join("&");
};
/** Queries with a key the call doesn't take: unknown, misspelled, `__proto__` (from JSON). */
const BAD_KEYS: Array<[string, Record<string, unknown>]> = [
  ["unknown key", { sex: "f" }],
  ["misspelled key", { filter: { sex: "f" } }],
  ["wrong-case key", { Filters: { sex: "f" } }],
  ["wire name of a typed option", { range_end: 5 }],
  ["__proto__ key", JSON.parse('{"__proto__": {"filters": {"sex": "f"}}}') as Record<string, unknown>],
];
/**
 * Filter names the API doesn't have. An ordinary unknown field (`foo=x`) is no case here: the
 * API rejects it itself with HTTP 500 "The following parameter(s) are not valid: foo"
 * (result 02, note 3), so it is sent. The JavaScript names never reached the API.
 */
const BAD_FILTER_NAMES: Array<[string, Record<string, unknown>]> = [
  ["__proto__ name (from JSON)", { filters: JSON.parse('{"sex": "f", "__proto__": "m"}') as Record<string, unknown> }],
  ["__proto__ with an operator", { filters: { "__proto__[eq]": "x" } }],
  ["constructor name", { filters: { constructor: "x" } }],
  ["prototype name", { filters: { prototype: "x" } }],
];
/** Values of the wrong type: arrays where the API takes one value, NaN, objects. */
const BAD_VALUES: Array<[string, Record<string, unknown>]> = [
  ["array filter", { filters: { sex: ["f", "m"] } }],
  ["array with a blank element", { filters: { sex: ["f", ""] } }],
  ["object filter", { filters: { year_of_birth: { a: 1 } } }],
  ["NaN filter", { filters: { year_of_birth: Number.NaN } }],
  ["Infinity filter", { filters: { "year_of_birth[gt]": Number.POSITIVE_INFINITY } }],
  ["Date filter", { filters: { year_of_birth: new Date(0) } }],
  ["NaN rangeEnd", { rangeEnd: Number.NaN }],
  ["array rangeStart", { rangeStart: [1, 2] }],
];
/**
 * Filter keys that differ from GOOD only in how they are spelled (padding, decomposed
 * characters): the API would read another field. abgeordnetenwatch field names are ASCII
 * identifiers, so such a key is rejected rather than guessed at.
 */
const UNNORMALISED: Array<[string, Record<string, unknown>]> = [
  ["padded key", { filters: { " sex": "f", "year_of_birth[gt]": 1990 } }],
  ["trailing space in key", { filters: { "sex ": "f", "year_of_birth[gt]": 1990 } }],
  ["space before the operator", { filters: { sex: "f", "year_of_birth [gt]": 1990 } }],
  ["NFD letter in key", { filters: { "séx": "f", "year_of_birth[gt]": 1990 } }],
];
const UNNORMALISED_POLICY = "reject" as "normalise" | "reject";
/** The CLI's filter given twice (same key), and what the repo does with it. */
const REPEATED_FLAG_ARGV = ["list", "politicians", "sex=f", "sex=m"];
const REPEATED_POLICY = "reject" as "combine" | "reject";
/** A single-value option given twice, which must be a usage error. */
const REPEATED_SINGLE_ARGV = ["list", "politicians", "--range-end", "5", "--range-end", "500"];
const USAGE_EXIT = 2;
/** Every request the client sends fetches data. */
const isDataRequest = (_req: HttpRequest): boolean => true;
/** The answer to any request. */
const respond = (_req: HttpRequest): HttpResponse => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: Buffer.from(JSON.stringify({ meta: { result: { count: 0, total: 0 } }, data: [] })),
});
/** CliDeps for this repo. */
const makeDeps = (io: CliDeps["io"], transport: (req: HttpRequest) => Promise<HttpResponse>): CliDeps => ({
  io,
  createClient: (opts) => new Client({ ...opts, transport }),
});
// --------------------------------------------------------------------------------------

function recorder() {
  const requests: HttpRequest[] = [];
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    return respond(req);
  };
  return { transport, data: () => requests.filter(isDataRequest) };
}

async function rejectsBeforeData(label: string, query: Record<string, unknown>): Promise<void> {
  const r = recorder();
  await assert.rejects(call(new Client({ transport: r.transport }), query), ValidationError, label);
  assert.equal(r.data().length, 0, `${label}: a data request went out`);
}

test("P10: the valid query goes out as given", async () => {
  const r = recorder();
  await call(new Client({ transport: r.transport }), GOOD.query);
  assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT]);
});

test("P10: an unknown, misspelled or __proto__ key is a validation error before any data request", async () => {
  for (const [label, query] of BAD_KEYS) await rejectsBeforeData(label, query);
});

test("P10: a filter name the API doesn't have is a validation error before any data request", async () => {
  for (const [label, query] of BAD_FILTER_NAMES) await rejectsBeforeData(label, query);
});

test("P10: an array, object or NaN where the API takes one value is a validation error", async () => {
  for (const [label, query] of BAD_VALUES) await rejectsBeforeData(label, query);
});

test("P10: a filter name spelled differently is normalised or rejected, never sent as typed", async () => {
  for (const [label, query] of UNNORMALISED) {
    if (UNNORMALISED_POLICY === "reject") {
      await rejectsBeforeData(label, query);
      continue;
    }
    const r = recorder();
    await call(new Client({ transport: r.transport }), query);
    assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT], label);
  }
});

test("P10: a repeated filter flag is combined or rejected, never last-one-wins", async () => {
  const r = recorder();
  const err: string[] = [];
  const code = await run(REPEATED_FLAG_ARGV, makeDeps({ out: () => {}, err: (s) => err.push(s) }, r.transport));
  if (REPEATED_POLICY === "combine") {
    assert.equal(code, 0, err.join("\n"));
    assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT]);
  } else {
    assert.equal(code, USAGE_EXIT);
    assert.equal(r.data().length, 0);
  }
});

test("P10: a repeated single-value option is a usage error", async () => {
  const r = recorder();
  const err: string[] = [];
  const code = await run(REPEATED_SINGLE_ARGV, makeDeps({ out: () => {}, err: (s) => err.push(s) }, r.transport));
  assert.equal(code, USAGE_EXIT, err.join("\n"));
  assert.equal(r.data().length, 0);
});
