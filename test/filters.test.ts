import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterBlankProblem,
  filterClashProblem,
  filterField,
  filterKeyProblem,
  filterOperatorProblem,
  reservedFilterProblem,
  validateFilters,
} from "../src/client/filters.js";
import { AwValidationError } from "../src/client/errors.js";
import { FILTER_OPERATORS } from "../src/client/types.js";

test("filterBlankProblem rejects a blank key or value", () => {
  for (const entry of [["sex", ""], ["sex", "  "], ["", "f"], [" ", "f"]] as const) {
    assert.equal(filterBlankProblem(entry), "Both key and value must be non-empty, e.g. sex=f.");
  }
  for (const entry of [["sex", "f"], ["year_of_birth[gt]", 1990], ["x", false], ["x", 0]] as const) {
    assert.equal(filterBlankProblem(entry), undefined);
  }
});

test("filterKeyProblem accepts a field name with at most one operator", () => {
  for (const key of ["sex", "year_of_birth[gt]", "_x", "last_name[zz]", "a[]"]) {
    assert.equal(filterKeyProblem(key), undefined, key);
  }
  for (const key of ["[gt]", "year_of_birth[gt]x", "a.b", "1a", "a[gt][lt]", " sex", "sex "]) {
    assert.match(filterKeyProblem(key) ?? "", /^Use a field name, optionally with one operator/, key);
  }
});

test("reservedFilterProblem rejects paging and sorting names, with or without an operator", () => {
  for (const key of ["range_start", "range_end", "sort_by", "sort_direction", "range_end[gt]"]) {
    assert.match(reservedFilterProblem(key) ?? "", /is a paging or sorting parameter, not a filter\.$/, key);
  }
  assert.equal(reservedFilterProblem("sex"), undefined);
});

test("filterOperatorProblem accepts exactly the documented operators", () => {
  for (const op of FILTER_OPERATORS) assert.equal(filterOperatorProblem(`x[${op}]`), undefined, op);
  assert.equal(filterOperatorProblem("sex"), undefined);
  assert.equal(
    filterOperatorProblem("last_name[zz]"),
    'Unknown filter operator "[zz]" in "last_name[zz]". Valid operators: eq, ne, gt, gte, lt, lte, cn, sw.',
  );
  assert.match(filterOperatorProblem("x[]") ?? "", /Unknown filter operator "\[\]"/);
});

test("filterClashProblem rejects a plain and a bracket key on one field, in either order", () => {
  assert.match(
    filterClashProblem(["year_of_birth", "year_of_birth[gt]"]) ?? "",
    /^Conflicting filters "year_of_birth" and "year_of_birth\[gt\]"/,
  );
  assert.match(filterClashProblem(["sex[ne]", "x", "sex"]) ?? "", /^Conflicting filters "sex\[ne\]" and "sex"/);
  assert.equal(filterClashProblem(["year_of_birth[gt]", "year_of_birth[lt]", "sex"]), undefined);
  assert.equal(filterField("year_of_birth[gt]"), "year_of_birth");
});

test("validateFilters throws AwValidationError naming the filter, and skips omitted values", () => {
  assert.throws(
    () => validateFilters({ sex: "" }),
    (err: unknown) =>
      err instanceof AwValidationError &&
      err.message === 'Invalid filter "sex": Both key and value must be non-empty, e.g. sex=f.',
  );
  assert.throws(() => validateFilters({ sex: "f", "sex[ne]": "m" }), /^AwValidationError: Invalid filters: Conflicting/);
  validateFilters({ sex: "f", "year_of_birth[gt]": 1990, skipped: undefined, alsoSkipped: null });
});
