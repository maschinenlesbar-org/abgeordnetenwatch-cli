// The rules for the free-form `filters` of list() and count(). The API does not
// reject a filter it cannot use: a blank or malformed one is dropped and the
// unfiltered set comes back as a success, and of a plain and a bracket filter on
// the same field it keeps only one. So the client checks every filter before it
// sends a request, and the CLI's filter parser calls the same rules.

import { FILTER_OPERATORS, type FilterValue } from "./types.js";
import { AwValidationError, quoteValue } from "./errors.js";
import { assertValid, describeValue, type Problem } from "./validate.js";

/** A filter key: a field name, optionally followed by one `[op]` suffix. */
export const FILTER_KEY = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[([^\]]*)\])?$/;

/**
 * Query parameters owned by the typed `rangeStart`, `rangeEnd`, `sortBy` and
 * `sortDirection` options. As filters they would bypass those options' checks
 * (and `count()`'s `range_end=1`), so they are not accepted as filter names.
 */
export const RESERVED_FILTER_FIELDS = ["range_start", "range_end", "sort_by", "sort_direction"] as const;

/**
 * Names that are never a field of any collection but have a meaning in JavaScript.
 * `__proto__` in particular was dropped silently: assigning it to a plain object sets the
 * prototype instead of adding a key, so the filter never reached the query string and the
 * unfiltered set came back with exit 0 (where the API rejects an unknown field).
 */
export const FORBIDDEN_FILTER_FIELDS = ["__proto__", "constructor", "prototype"] as const;

/**
 * Rule for a filter value: one string, finite number or boolean. An array went out as
 * repeated keys (`sex=f&sex=m`), of which the API keeps one — a blank element included,
 * which it treats as no filter — and NaN, Infinity or an object went out as text
 * (`NaN`, `[object Object]`).
 */
export const filterValueProblem: Problem<unknown> = (value) => {
  if (Array.isArray(value)) {
    return "Expected one value; the API keeps only one of repeated keys.";
  }
  if (typeof value === "number") return Number.isFinite(value) ? undefined : `Expected a finite number, got ${String(value)}.`;
  if (typeof value === "string" || typeof value === "boolean") return undefined;
  return `Expected a string, number or boolean, got ${describeValue(value)}.`;
};

/** Rule: neither the key nor the value of a filter may be blank. */
export const filterBlankProblem: Problem<readonly [string, FilterValue]> = ([key, value]) =>
  key.trim() === "" || String(value).trim() === ""
    ? "Both key and value must be non-empty, e.g. sex=f."
    : undefined;

/**
 * Rule: the key is a field name with at most one bracket operator. The API ignores
 * anything else: `[gt]=1990` drops the filter, `field[gt]x` loses the trailing text.
 */
export const filterKeyProblem: Problem<string> = (key) => {
  if (!FILTER_KEY.test(key)) {
    return "Use a field name, optionally with one operator: sex=f or 'year_of_birth[gt]=1990'.";
  }
  const field = filterField(key);
  return (FORBIDDEN_FILTER_FIELDS as readonly string[]).includes(field)
    ? `"${field}" is not a field of any collection.`
    : undefined;
};

/** Rule: the key's field is not a paging or sorting parameter ({@link RESERVED_FILTER_FIELDS}). */
export const reservedFilterProblem: Problem<string> = (key) => {
  const field = filterField(key);
  return (RESERVED_FILTER_FIELDS as readonly string[]).includes(field)
    ? `"${field}" is a paging or sorting parameter, not a filter.`
    : undefined;
};

/** Rule: a bracket operator is one of {@link FILTER_OPERATORS}; the API answers any other with HTTP 500. */
export const filterOperatorProblem: Problem<string> = (key) => {
  const op = FILTER_KEY.exec(key)?.[2];
  if (op === undefined || (FILTER_OPERATORS as readonly string[]).includes(op)) return undefined;
  return `Unknown filter operator "[${quoteValue(op)}]" in ${describeValue(key)}. Valid operators: ${FILTER_OPERATORS.join(", ")}.`;
};

/**
 * Rule over the filter keys in order: no plain key next to a bracket key on the
 * same field (`year_of_birth=1990` and `year_of_birth[gt]=2000`). The API parses
 * them into one parameter and keeps only the last, so one filter would be dropped.
 * Two different operators on one field are fine.
 */
export const filterClashProblem: Problem<readonly string[]> = (keys) => {
  for (let i = 1; i < keys.length; i++) {
    const key = keys[i] as string;
    const field = filterField(key);
    const clash = keys
      .slice(0, i)
      .find((prev) => filterField(prev) === field && (prev === field || key === field));
    if (clash !== undefined) {
      return (
        `Conflicting filters "${quoteValue(clash)}" and "${quoteValue(key)}": the API keeps only one of a plain and a ` +
        `bracket filter on the same field. Use operators only, e.g. '${quoteValue(field)}[eq]=…'.`
      );
    }
  }
  return undefined;
};

/** The field name of a filter key: `year_of_birth[gt]` -> `year_of_birth`. */
export function filterField(key: string): string {
  const bracket = key.indexOf("[");
  return bracket === -1 ? key : key.slice(0, bracket);
}

/**
 * Check a filters object against every filter rule; throws AwValidationError
 * (`Invalid filter "<key>": <reason>`) at the first problem. An `undefined` or
 * `null` value means the filter is omitted, as in the query string. Every other
 * value must be one string, finite number or boolean (filterValueProblem), and
 * `__proto__`, `constructor` and `prototype` are no field names (filterKeyProblem).
 */
export function validateFilters(filters: Readonly<Record<string, FilterValue | null | undefined>>): void {
  if (typeof filters !== "object" || filters === null || Array.isArray(filters)) {
    throw new AwValidationError(
      `Invalid filters: expected an object of field names and values, got ${describeValue(filters)}.`,
    );
  }
  const keys: string[] = [];
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null) continue;
    const name = `filter ${describeValue(key)}`;
    assertValid(name, value, filterValueProblem);
    assertValid(name, [key, value] as const, filterBlankProblem);
    assertValid(name, key, filterKeyProblem);
    assertValid(name, key, reservedFilterProblem);
    assertValid(name, key, filterOperatorProblem);
    keys.push(key);
  }
  assertValid("filters", keys, filterClashProblem);
}
