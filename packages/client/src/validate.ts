// Input validation shared by the client and the CLI. Each rule is a pure
// `Problem` function: it returns the reason a value is invalid, or undefined when
// the value is fine. The client enforces a rule with assertValid() before it sends
// a request; the CLI's commander parsers call the same Problem functions, so a
// rule is written once and both layers reject exactly the same inputs.

import { AwValidationError, quoteValue } from "./errors.js";
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
  assertValid(`id ${describeValue(String(id))}`, id, entityIdProblem);
  return String(id).replace(/^0+/, "");
}

/**
 * Rule: a value that is not blank. The API treats an empty parameter as no
 * parameter at all, so a blank value would silently be ignored.
 */
export const nonBlankProblem: Problem<unknown> = (value) =>
  typeof value !== "string" || value.trim() === "" ? "Expected a non-empty value." : undefined;

/** Unicode General Category Cf (format): bidi controls, zero-width characters, U+00AD, U+FEFF, … */
const FORMAT_CHAR = /\p{Cf}/u;

/**
 * A rejected value as a message shows it: a string quoted as `JSON.stringify` does, with any URL
 * userinfo cut out (`redactUrl`, so a credential URL passed in the wrong place never reaches the
 * message) and cut at `MAX_QUOTED_LENGTH`. What JSON leaves raw although it is invisible or a
 * terminal acts on it is escaped too: DEL, the C1 controls, every Unicode format character (a
 * zero-width space, a soft hyphen, a bidi override) and U+2028/U+2029 (`"a\u200bb"`), so a
 * refusal shows the character that caused it, and the quoted part stays a valid JSON string.
 */
export function describeValue(value: unknown): string {
  if (typeof value !== "string") return String(value);
  let out = "";
  for (const ch of JSON.stringify(quoteValue(value))) {
    const n = ch.codePointAt(0) ?? 0;
    if ((n >= 0x7f && n <= 0x9f) || n === 0x2028 || n === 0x2029 || FORMAT_CHAR.test(ch)) {
      // One escape per UTF-16 unit, so a character above U+FFFF stays valid JSON.
      for (let i = 0; i < ch.length; i++) out += `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * A parameter object: a plain object, not null, an array or a primitive. Checked first, so a
 * wrong-typed argument (`list("parties", null)`) is an AwValidationError rather than a raw
 * TypeError from reading its fields, and `count("parties", 5)` sends no request.
 */
export function assertParams<T>(name: string, value: T): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AwValidationError(`Invalid ${name}: expected an object of parameters, got ${describeValue(value)}.`);
  }
  return value;
}

/** Rule for `rangeStart` and `rangeEnd`: a non-negative safe integer. */
export const rangeProblem: Problem<unknown> = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? undefined
    : `Expected a non-negative integer up to ${Number.MAX_SAFE_INTEGER}, got ${describeValue(value)}.`;

/** Rule for `sortDirection`: one of {@link SORT_DIRECTIONS}; the API answers anything else with HTTP 500. */
export const sortDirectionProblem: Problem<unknown> = (value) =>
  (SORT_DIRECTIONS as readonly unknown[]).includes(value) ? undefined : `${describeValue(value)} is not a sort direction; use "asc" or "desc".`;

/** A field name, as `sort_by` takes it: the field part of a filter key (`FILTER_KEY`), without an operator. */
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Rule for `sortBy`: a token ({@link tokenProblem}: not blank, no invisible, control or half
 * character) that is, once trimmed, the name of a field (letters, digits and `_`, not starting
 * with a digit). The API sorts by an entity field and answers anything else with HTTP 500
 * (`last_name  is not a valid value for sort_by`), whose message hid a trailing space. The
 * value is sent trimmed ({@link normalizeToken}). Which fields sort is the API's to say (polls
 * not by `id`): that is left to it.
 */
export const sortByProblem: Problem<unknown> = (value) => {
  if (typeof value !== "string") return "Expected a string.";
  const token = tokenProblem(value);
  if (token !== undefined) return token;
  return FIELD_NAME.test(value.trim())
    ? undefined
    : `${describeValue(value)} is not a field name (letters, digits and _, e.g. last_name or field_poll_date).`;
};

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
  if (params.sortBy !== undefined) assertValid("sortBy", params.sortBy, sortByProblem);
  if (params.sortDirection !== undefined) {
    assertValid("sortDirection", params.sortDirection, sortDirectionProblem);
  }
  assertValid("sortDirection", params, sortPairProblem);
}

/** Characters that never make a value non-blank: whitespace, controls, format characters, combining marks. */
const INVISIBLE = /[\s\p{Cc}\p{Cf}\p{M}]/gu;

/** A lone surrogate: half of a character, which URLSearchParams would send as U+FFFD. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * True when nothing in `value` would match anything: it holds only whitespace, control and
 * format characters (a zero-width space, a soft hyphen) and combining marks. Such a value reads
 * as "no filter" upstream, or matches nothing, so it is refused as blank.
 */
function isBlank(value: string): boolean {
  return value.replace(INVISIBLE, "") === "";
}

/** `U+200B` for the first character of `text` that `pattern` matches. */
function codePointOf(text: string, pattern: RegExp): string {
  const ch = pattern.exec(text)?.[0] ?? "";
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** A control character inside a text filter: C0 and C1, but not TAB, LF or CR (whitespace in a pasted phrase). */
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/** A format character inside a text filter, but not ZWNJ/ZWJ (U+200C/U+200D), which some scripts and emoji need. */
const TEXT_FORMAT = /(?![\u200c\u200d])\p{Cf}/u;

/**
 * Why `value` cannot be sent as a text filter, or undefined when it can. Refused, before any
 * request, as the API would match nothing or everything:
 * - a value that is blank once trimmed (Unicode whitespace, U+00A0 included), or that holds only
 *   invisible characters and combining marks (`isBlank`): an empty filter reads as "no filter"
 *   upstream, which answers with the whole unfiltered list;
 * - a lone surrogate (half of a character, sent as U+FFFD);
 * - a control character (but TAB, LF and CR) or a format character (a zero-width space, a soft
 *   hyphen, a bidi control; ZWNJ and ZWJ are allowed): pasted along, it makes the search find
 *   nothing (`last_name=<ZWSP>Scholz` counted 0 where `Scholz` counted 31).
 * The reason quotes the value with every invisible character escaped (`describeValue`).
 */
export function textProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  if (LONE_SURROGATE.test(value)) return `${describeValue(value)} contains half of a character (a lone surrogate).`;
  if (TEXT_CONTROL.test(value)) return `${describeValue(value)} contains a control character (${codePointOf(value, TEXT_CONTROL)}).`;
  if (TEXT_FORMAT.test(value)) return `${describeValue(value)} contains an invisible character (${codePointOf(value, TEXT_FORMAT)}).`;
  return undefined;
}

/**
 * A text filter as the API matches it: without surrounding whitespace (a value pasted with a
 * trailing space matched nothing) and in composed Unicode, NFC (a decomposed "Müller", u plus
 * U+0308 as pasted from a macOS file name, matched nothing). Inner whitespace is kept.
 */
export function normalizeText(value: string): string {
  return value.trim().normalize("NFC");
}

/** A control or format character in a token (after trimming): every Cc and every Cf. */
const TOKEN_INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/**
 * Why `value` cannot be sent as a token, or undefined when it can. A token is an id, a code, an
 * enum value or a sort key: a value the API compares exactly. The rules apply to the value with
 * surrounding whitespace trimmed, as it is sent ({@link normalizeToken}): not blank (and not only
 * invisible characters or combining marks), no lone surrogate, and no control or format character
 * at all (a zero-width space, ZWJ, a soft hyphen, a bidi control), since an invisible character in
 * an id or a code only ever makes it match nothing. The reason quotes the value visibly.
 */
export function tokenProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  const token = value.trim();
  if (LONE_SURROGATE.test(token)) return `${describeValue(value)} contains half of a character (a lone surrogate).`;
  if (TOKEN_INVISIBLE.test(token)) {
    return `${describeValue(value)} contains an invisible or control character (${codePointOf(token, TOKEN_INVISIBLE)}).`;
  }
  return undefined;
}

/** A token as it is sent: trimmed and in composed Unicode (NFC). Check it with {@link tokenProblem} first. */
export function normalizeToken(value: string): string {
  return value.trim().normalize("NFC");
}

/**
 * The items of a comma-separated list, as typed: each item is checked (`listProblem`) and
 * canonicalised (`normalizeToken`) on its own, so `"a1, a2"` sends `a2`, and `"a1,,a2"`, `"a1,"`
 * and `","` are refused rather than sent as an empty item (which an API may read as "no filter").
 * This CLI has no list option; the rule is the kit's, for library callers.
 */
export function splitList(value: string): string[] {
  return value.split(",");
}

/**
 * Why `items` cannot be sent as a list, or undefined when it can: not an array of strings, no
 * item at all (an empty list reads as "no filter"), or an item that `itemProblem` refuses (by
 * default {@link tokenProblem}: a blank item is refused, never dropped). The reason names the item.
 */
export function listProblem(items: readonly string[], itemProblem: Problem<string> = tokenProblem): string | undefined {
  if (!Array.isArray(items)) return "Expected a list of strings.";
  if (items.length === 0) return "Expected at least one value.";
  for (let i = 0; i < items.length; i++) {
    const problem = itemProblem(items[i] as string);
    if (problem !== undefined) return items.length === 1 ? problem : `item ${i + 1} of ${items.length}: ${problem}`;
  }
  return undefined;
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
 * fragment, no surrounding whitespace, and no `%` in the userinfo that doesn't start
 * an escape (`%25` for a literal one: the engine percent-decodes it for the
 * Authorization header). Request paths are appended to it as a
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
  // The userinfo is percent-decoded for the Authorization header; a "%" that isn't an
  // escape fails there ("URI malformed") at request time, as a raw URIError. Reject it here.
  for (const part of [url.username, url.password]) {
    try {
      decodeURIComponent(part);
    } catch {
      return 'The user name or password has a "%" that is not followed by two hex digits; write a literal "%" as %25.';
    }
  }
  return undefined;
};
