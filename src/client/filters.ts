// The rules for the free-form `filters` of list() and count(). The API does not
// reject a filter it cannot use: a blank or malformed one is dropped and the
// unfiltered set comes back as a success, and of a plain and a bracket filter on
// the same field it keeps only one. So the client checks every filter before it
// sends a request, and the CLI's filter parser calls the same rules.

import { FILTER_OPERATORS, type FilterValue } from "./types.js";
import { AwValidationError } from "./errors.js";
import { assertValid, describeValue, type Problem } from "./validate.js";

/** A filter key: a field name, optionally followed by one `[op]` suffix. */
export const FILTER_KEY = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[([^\]]*)\])?$/;

/**
 * Query parameters owned by the typed `rangeStart`, `rangeEnd`, `sortBy` and
 * `sortDirection` options. As filters they would bypass those options' checks
 * (and `count()`'s `range_end=1`), so they are not accepted as filter names.
 */
export const RESERVED_FILTER_FIELDS = ["range_start", "range_end", "sort_by", "sort_direction"] as const;

/** Rule: neither the key nor the value of a filter may be blank. */
export const filterBlankProblem: Problem<readonly [string, FilterValue]> = ([key, value]) =>
  key.trim() === "" || String(value).trim() === ""
    ? "Both key and value must be non-empty, e.g. sex=f."
    : undefined;

/**
 * Rule: the key is a field name with at most one bracket operator. The API ignores
 * anything else: `[gt]=1990` drops the filter, `field[gt]x` loses the trailing text.
 */
export const filterKeyProblem: Problem<string> = (key) =>
  FILTER_KEY.test(key)
    ? undefined
    : "Use a field name, optionally with one operator: sex=f or 'year_of_birth[gt]=1990'.";

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
  return `Unknown filter operator "[${op}]" in ${describeValue(key)}. Valid operators: ${FILTER_OPERATORS.join(", ")}.`;
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
        `Conflicting filters "${clash}" and "${key}": the API keeps only one of a plain and a ` +
        `bracket filter on the same field. Use operators only, e.g. '${field}[eq]=…'.`
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
 * `null` value means the filter is omitted, as in the query string.
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
    assertValid(name, [key, value] as const, filterBlankProblem);
    assertValid(name, key, filterKeyProblem);
    assertValid(name, key, reservedFilterProblem);
    assertValid(name, key, filterOperatorProblem);
    keys.push(key);
  }
  assertValid("filters", keys, filterClashProblem);
}
