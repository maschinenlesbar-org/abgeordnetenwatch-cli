import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertValid,
  entityIdProblem,
  normalizeEntityId,
  nonBlankProblem,
  rangeProblem,
  sortDirectionProblem,
  sortPairProblem,
  validateListParams,
  headerNameProblem,
  headerValueProblem,
  baseUrlProblem,
  type Problem,
} from "../src/client/validate.js";
import { AbgeordnetenwatchClient } from "../src/client/client.js";
import type { EngineOptions } from "../src/client/engine.js";
import { makeMockTransport, jsonResponse } from "./helpers.js";
import { AwError, AwValidationError } from "../src/client/errors.js";
import * as library from "../src/index.js";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";

const notBlank: Problem<string> = (value) =>
  value.trim() === "" ? "Expected a non-empty value." : undefined;

test("assertValid returns a valid value unchanged", () => {
  assert.equal(assertValid("sortBy", "last_name", notBlank), "last_name");
});

test("assertValid throws AwValidationError naming the input and the reason", () => {
  assert.throws(
    () => assertValid("sortBy", " ", notBlank),
    (err: unknown) =>
      err instanceof AwValidationError &&
      err instanceof AwError &&
      err.name === "AwValidationError" &&
      err.message === "Invalid sortBy: Expected a non-empty value.",
  );
});

test("the validation layer is part of the library's public surface", () => {
  assert.equal(library.AwValidationError, AwValidationError);
  assert.equal(library.assertValid, assertValid);
});

test("run() maps an AwValidationError from an action to a usage error (exit 2)", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    io: { out: (t) => out.push(t), err: (t) => err.push(t) },
    createClient: () =>
      ({
        list: async () => {
          throw new AwValidationError("Invalid sortDirection: needs sortBy.");
        },
      }) as unknown as AbgeordnetenwatchClient,
  };
  assert.equal(await run(["list", "politicians"], deps), 2);
  assert.deepEqual(out, []);
  assert.deepEqual(err, ["Error: Invalid sortDirection: needs sortBy."]);
});

test("entityIdProblem accepts positive integers as numbers or digit strings", () => {
  for (const id of [1, 42, Number.MAX_SAFE_INTEGER, "1", "0002", "184945"]) {
    assert.equal(entityIdProblem(id), undefined, String(id));
  }
});

test("entityIdProblem rejects zero, blanks, signs, fractions and non-digits", () => {
  for (const id of [0, "0", "000"]) {
    assert.equal(entityIdProblem(id), "Entity ids start at 1.", JSON.stringify(id));
  }
  for (const id of [-1, 1.5, NaN, Infinity, 2 ** 53, "", " ", " 2 ", "abc", "-1", "+1", "1.5", "1e3", "\uff12"]) {
    assert.equal(entityIdProblem(id), "Expected a numeric entity id.", JSON.stringify(id));
  }
});

test("normalizeEntityId drops leading zeros, is idempotent and throws AwValidationError", () => {
  assert.equal(normalizeEntityId("0002"), "2");
  assert.equal(normalizeEntityId(normalizeEntityId("0002")), "2");
  assert.equal(normalizeEntityId(184945), "184945");
  assert.throws(
    () => normalizeEntityId("0"),
    (err: unknown) =>
      err instanceof AwValidationError && err.message === 'Invalid id "0": Entity ids start at 1.',
  );
  assert.throws(
    () => normalizeEntityId("abc"),
    (err: unknown) =>
      err instanceof AwValidationError &&
      err.message === 'Invalid id "abc": Expected a numeric entity id.',
  );
});

test("nonBlankProblem rejects blank and non-string values", () => {
  for (const value of ["", " ", "\t\n", undefined, 5]) {
    assert.equal(nonBlankProblem(value), "Expected a non-empty value.", JSON.stringify(value));
  }
  assert.equal(nonBlankProblem("last_name"), undefined);
});

test("rangeProblem accepts non-negative safe integers only", () => {
  for (const value of [0, 1, 1000, Number.MAX_SAFE_INTEGER]) assert.equal(rangeProblem(value), undefined);
  for (const value of [-1, 1.5, NaN, Infinity, 1e20, "5", undefined]) {
    assert.match(rangeProblem(value) ?? "", /^Expected a non-negative integer/, String(value));
  }
});

test("sortDirectionProblem and sortPairProblem", () => {
  assert.equal(sortDirectionProblem("asc"), undefined);
  assert.equal(sortDirectionProblem("desc"), undefined);
  for (const value of ["ASC", "", "up", undefined]) {
    assert.equal(sortDirectionProblem(value), 'Use "asc" or "desc".', String(value));
  }
  assert.equal(sortPairProblem({ sortDirection: "asc" }), "sortDirection needs sortBy (the API rejects it on its own).");
  assert.equal(sortPairProblem({ sortBy: "id", sortDirection: "asc" }), undefined);
  assert.equal(sortPairProblem({ sortBy: "id" }), undefined);
});

test("validateListParams names the parameter in its AwValidationError", () => {
  assert.throws(
    () => validateListParams({ rangeStart: -1 }),
    (err: unknown) =>
      err instanceof AwValidationError && /^Invalid rangeStart: Expected a non-negative integer/.test(err.message),
  );
  assert.throws(() => validateListParams({ sortBy: " " }), /Invalid sortBy: Expected a non-empty value\./);
  assert.throws(
    () => validateListParams({ sortDirection: "asc" }),
    /Invalid sortDirection: sortDirection needs sortBy/,
  );
  validateListParams({ rangeStart: 0, rangeEnd: 5, sortBy: "id", sortDirection: "desc" });
});

test("count() checks the caller's paging and sort parameters before any request", async () => {
  const mt = makeMockTransport(() => jsonResponse({ meta: { result: { total: 1 } }, data: [] }));
  const client = new AbgeordnetenwatchClient({ transport: mt.transport });
  for (const params of [{ sortDirection: "asc" as const }, { rangeStart: -1 }, { rangeEnd: 1.5 }]) {
    await assert.rejects(client.count("politicians", params), AwValidationError, JSON.stringify(params));
  }
  assert.equal(mt.calls.length, 0);
});

test("headerValueProblem rejects blanks, control characters but tab, DEL and non-Latin-1", () => {
  for (const [value, reason] of [
    ["", "Expected a non-empty value."],
    ["  ", "Expected a non-empty value."],
    ["a\r\nX-Injected: 1", "Value contains control characters."],
    ["a\u0000b", "Value contains control characters."],
    [`a${String.fromCharCode(0x7f)}`, "Value contains control characters."],
    ["\u20acuro", "Value contains characters outside Latin-1 (above U+00FF)."],
  ] as const) {
    assert.equal(headerValueProblem(value), reason, JSON.stringify(value));
  }
  for (const value of ["my-ua/1.0", "müller-bot/1.0\t(test)", "é"]) {
    assert.equal(headerValueProblem(value), undefined, value);
  }
});

test("headerNameProblem accepts HTTP tokens only", () => {
  for (const name of ["X-Api-Key", "Accept", "x_y.z"]) assert.equal(headerNameProblem(name), undefined, name);
  for (const name of ["", "X Y", "X:Y", "X\r\nY", "Ü"]) {
    assert.match(headerNameProblem(name) ?? "", /^Expected an HTTP header name/, JSON.stringify(name));
  }
});

test("the client rejects a bad userAgent or header at construction, before any request", () => {
  const mt = makeMockTransport(() => jsonResponse({ meta: {}, data: [] }));
  const cases: EngineOptions[] = [
    { userAgent: "" },
    { userAgent: "a\r\nX-Injected: 1" },
    { userAgent: "\u20ac" },
    { headers: { "X-Test": "a\nb" } },
    { headers: { "X-Test": " " } },
    { headers: { "X Bad": "v" } },
  ];
  for (const options of cases) {
    assert.throws(
      () => new AbgeordnetenwatchClient({ ...options, transport: mt.transport }),
      (err: unknown) => err instanceof AwValidationError && /^Invalid (userAgent|header)/.test(err.message),
      JSON.stringify(options),
    );
  }
  assert.equal(mt.calls.length, 0);
  new AbgeordnetenwatchClient({ userAgent: "ok/1.0", headers: { "X-Test": "v" }, transport: mt.transport });
});

test("baseUrlProblem accepts absolute http(s) URLs only, without query, fragment or padding", () => {
  for (const url of ["https://www.abgeordnetenwatch.de", "http://127.0.0.1:8080/aw/", "https://u:p@h.example"]) {
    assert.equal(baseUrlProblem(url), undefined, url);
  }
  for (const [url, reason] of [
    ["", "Expected an absolute http(s) URL."],
    ["notaurl", "Expected an absolute http(s) URL."],
    ["ftp://example.org", 'Unsupported scheme "ftp:". Expected an http(s) URL.'],
    ["https://h.example/?x=1", "A base URL cannot have a query (?) or fragment (#)."],
    ["https://h.example#f", "A base URL cannot have a query (?) or fragment (#)."],
    ["https://h.example/ ", "A base URL cannot have surrounding whitespace."],
    ["\thttps://h.example", "A base URL cannot have surrounding whitespace."],
  ] as const) {
    assert.equal(baseUrlProblem(url), reason, JSON.stringify(url));
  }
});
