// Input validation shared by the client and the CLI. Each rule is a pure
// `Problem` function: it returns the reason a value is invalid, or undefined when
// the value is fine. The client enforces a rule with assertValid() before it sends
// a request; the CLI's commander parsers call the same Problem functions, so a
// rule is written once and both layers reject exactly the same inputs.

import { AwValidationError } from "./errors.js";
import { SORT_DIRECTIONS, type ListParams } from "./types.js";

/**
 * A validation rule: returns the reason `value` is invalid (one sentence, e.g.
 * `"Expected a non-empty value."`), or `undefined` when it is valid.
 */
export type Problem<T = unknown> = (value: T) => string | undefined;

/**
 * Enforce a rule: throw {@link AwValidationError} with the message
 * `Invalid <name>: <reason>` when `problem(value)` reports one, else return `value`
 * unchanged. Client methods that return a promise call it inside the async body,
 * so a rejected input rejects the promise (and sends no request) instead of
 * throwing synchronously.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) throw new AwValidationError(`Invalid ${name}: ${reason}`);
  return value;
}

/**
 * Rule for an entity id (`get`). Ids are positive decimal integers: a number must
 * be a safe integer of at least 1, a string a run of ASCII digits that is not all
 * zeros. The API treats `/<collection>/0` (and an empty id) as the collection
 * itself, and answers anything else that is not a number with a generic HTTP 500.
 */
export const entityIdProblem: Problem<number | string> = (id) => {
  if (typeof id === "number") {
    if (!Number.isSafeInteger(id) || id < 0) return "Expected a numeric entity id.";
    return id === 0 ? "Entity ids start at 1." : undefined;
  }
  if (typeof id !== "string" || !/^[0-9]+$/.test(id)) return "Expected a numeric entity id.";
  return /^0+$/.test(id) ? "Entity ids start at 1." : undefined;
};

/**
 * The canonical form of an entity id: checked with {@link entityIdProblem} (throws
 * AwValidationError), leading zeros dropped. The API looks the id up as a string,
 * so `0002` would be "no such entity" although party 2 exists. Idempotent.
 */
export function normalizeEntityId(id: number | string): string {
  assertValid(`id "${String(id)}"`, id, entityIdProblem);
  return String(id).replace(/^0+/, "");
}

/**
 * Rule: a value that is not blank. The API treats an empty parameter as no
 * parameter at all, so a blank value would silently be ignored.
 */
export const nonBlankProblem: Problem<unknown> = (value) =>
  typeof value !== "string" || value.trim() === "" ? "Expected a non-empty value." : undefined;

/** Rule for `rangeStart` and `rangeEnd`: a non-negative safe integer. */
export const rangeProblem: Problem<unknown> = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? undefined
    : `Expected a non-negative integer up to ${Number.MAX_SAFE_INTEGER}, got ${String(value)}.`;

/** Rule for `sortDirection`: one of {@link SORT_DIRECTIONS}; the API answers anything else with HTTP 500. */
export const sortDirectionProblem: Problem<unknown> = (value) =>
  (SORT_DIRECTIONS as readonly unknown[]).includes(value) ? undefined : `Use "asc" or "desc".`;

/** Rule across two parameters: a `sortDirection` needs a `sortBy`; the API rejects it alone. */
export const sortPairProblem: Problem<ListParams> = (params) =>
  params.sortDirection !== undefined && params.sortBy === undefined
    ? "sortDirection needs sortBy (the API rejects it on its own)."
    : undefined;

/**
 * Check the paging and sorting parameters of list() and count(); throws
 * AwValidationError (`Invalid <param>: <reason>`) at the first problem. The filters
 * are checked separately (validateFilters).
 */
export function validateListParams(params: ListParams): void {
  if (params.rangeStart !== undefined) assertValid("rangeStart", params.rangeStart, rangeProblem);
  if (params.rangeEnd !== undefined) assertValid("rangeEnd", params.rangeEnd, rangeProblem);
  if (params.sortBy !== undefined) assertValid("sortBy", params.sortBy, nonBlankProblem);
  if (params.sortDirection !== undefined) {
    assertValid("sortDirection", params.sortDirection, sortDirectionProblem);
  }
  assertValid("sortDirection", params, sortPairProblem);
}

/**
 * Rule for an HTTP header value (the User-Agent, `headers`): not blank, no C0
 * control character other than tab (so no CR/LF header injection), no DEL and
 * nothing above U+00FF. Node's HTTP layer throws an opaque "Invalid character in
 * header content" at request time for those. Checked by char code so the source
 * stays free of control bytes.
 */
export const headerValueProblem: Problem<unknown> = (value) => {
  const blank = nonBlankProblem(value);
  if (blank !== undefined) return blank;
  const text = value as string;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return "Value contains control characters.";
    if (c > 0xff) return "Value contains characters outside Latin-1 (above U+00FF).";
  }
  return undefined;
};

/** Rule for an HTTP header name: an RFC 9110 token. */
export const headerNameProblem: Problem<unknown> = (value) =>
  typeof value === "string" && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)
    ? undefined
    : "Expected an HTTP header name (letters, digits and !#$%&'*+.^_`|~-).";

/**
 * Rule for the base URL: an absolute `http:`/`https:` URL with no query or
 * fragment and no surrounding whitespace. Request paths are appended to it as a
 * string, so a `?` or `#` would swallow every path, and `new URL()` trims
 * surrounding whitespace silently while the engine would keep the raw value
 * (`"https://h/ "` requested `/%20/api/v2/...`).
 */
export const baseUrlProblem: Problem<unknown> = (value) => {
  if (typeof value !== "string") return "Expected an absolute http(s) URL.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Expected an absolute http(s) URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Unsupported scheme "${url.protocol}". Expected an http(s) URL.`;
  }
  if (/[?#]/.test(value)) return "A base URL cannot have a query (?) or fragment (#).";
  if (value !== value.trim()) return "A base URL cannot have surrounding whitespace.";
  return undefined;
};
