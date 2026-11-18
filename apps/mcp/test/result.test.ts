// Shaping answers: strings cleaned in the value, results fitted by dropping whole entries.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanStrings, fitResult, MAX_FIELD_LENGTH } from "../src/mcp/result.js";

test("cleanStrings drops control, bidi, zero-width and separator characters, keeps text, tabs and newlines", () => {
  const dirty = { name: "Müller‮\u0000​﻿ x", note: "a\tb\nc", list: ["\u0085y", 3, null, true] };
  assert.deepEqual(cleanStrings(dirty), { name: "Müllerx", note: "a\tb\nc", list: ["y", 3, null, true] });
});

test("cleanStrings replaces lone surrogates and cuts long text with an ellipsis", () => {
  assert.equal(cleanStrings("a\ud800b"), "a�b");
  const long = cleanStrings("x".repeat(MAX_FIELD_LENGTH + 10));
  assert.equal(long.length, MAX_FIELD_LENGTH + 1);
  assert.ok(long.endsWith("…"));
});

test("fitResult leaves a result that fits alone, and otherwise drops entries from the longest list", () => {
  const small = { status: "ok", data: [1, 2] };
  assert.equal(fitResult(small, 1000), small);
  const big = { status: "ok", data: Array.from({ length: 50 }, (_, i) => `item ${i} ${"x".repeat(20)}`), other: ["a"] };
  const fitted: Record<string, unknown> = fitResult(big, 300, { list: "data", offset: 40 });
  assert.ok(JSON.stringify(fitted).length <= 300);
  assert.equal(fitted["truncated"], true);
  assert.deepEqual(fitted["other"], ["a"]);
  assert.equal(fitted["nextOffset"], 40 + (fitted["data"] as unknown[]).length);
  assert.equal(big.data.length, 50, "the input is not changed");
});
