// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

/**
 * Replace the userinfo of a URL (`https://user:secret@host/...`) with `***`, so a
 * credential in a base URL never reaches an error message, a log or CI output.
 * A value that does not parse as a URL (a port typo, an unencoded `#` in the
 * password) has its userinfo cut out by text ({@link credentialsIn}); a value
 * without userinfo is returned unchanged.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // A value that doesn't parse can still carry credentials: cut them out by text.
    return redactCredentials(url, credentialsIn(url));
  }
  // `user:pw@host` without a scheme parses as a URL with the scheme "user:": no userinfo.
  if (parsed.username === "" && parsed.password === "") return redactCredentials(url, credentialsIn(url));
  parsed.username = "***";
  parsed.password = "";
  return parsed.href;
}

/**
 * The userinfo a URL-like value carries, exactly as written — `["alice:pa#ss"]` for
 * `https://alice:pa#ss@host` — or `[]` when it carries none. It works on values that don't
 * parse as a URL too, and on values with a prefix (`--base-url=https://u:p@h`): the userinfo
 * is everything between `://` and the last `@` before the host. A value without a scheme
 * counts when it reads `user:password@host`. Used to redact those exact strings from text
 * that echoes the value (usage errors, help), whatever characters the password contains.
 */
export function credentialsIn(value: string): string[] {
  const schemeAt = value.indexOf("://");
  const rest = schemeAt >= 0 ? value.slice(schemeAt + 3) : value;
  // Without a scheme only the unmistakable `user:password@host` form counts.
  if (schemeAt < 0 && !/^[^\s/@:]+:[^@]*@[^@\s/]/.test(rest)) return [];
  // The URL itself starts at its scheme (`--base-url=https://…` has a prefix).
  const scheme = schemeAt >= 0 ? /[a-z][a-z0-9+.-]*$/i.exec(value.slice(0, schemeAt)) : null;
  let parses = false;
  try {
    new URL(schemeAt >= 0 ? value.slice(scheme?.index ?? schemeAt) : `http://${rest}`);
    parses = true;
  } catch {
    // Doesn't parse: the password may hold "/", "?", "#" or spaces.
  }
  // In a URL that parses, the userinfo ends at the last "@" of the authority (before the
  // first "/", "?" or "#"); in one that doesn't, at the last "@" of the value.
  const authority = parses ? rest.slice(0, rest.search(/[/?#]|$/)) : rest;
  const end = authority.lastIndexOf("@");
  return end > 0 ? [rest.slice(0, end)] : [];
}

/**
 * `text` with every occurrence of each credential (as {@link credentialsIn} returns them)
 * that is followed by `@` replaced by `***`. Matching the exact strings, not a pattern,
 * covers passwords with spaces, quotes, `#`, `?` or `/` that no URL pattern can delimit.
 */
export function redactCredentials(text: string, credentials: readonly string[]): string {
  let out = text;
  for (const secret of credentials) {
    if (secret === "") continue;
    out = out.split(`${secret}@`).join("***@");
  }
  return out;
}

/**
 * `text` cut to at most `max` UTF-16 units, never inside a surrogate pair: when the cut
 * would land after a high surrogate it is made one unit earlier, so a message that holds
 * the cut text is well-formed (a lone `\ud83d` makes jq reject a whole JSON stream).
 * Text no longer than `max` is returned as it is; the caller marks a cut.
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = max > 0 && isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
}

/**
 * Longest server text (in characters) an error message shows; `AwApiError.body` keeps
 * the whole body. A proxy's 200 kB error page would otherwise flood the terminal.
 */
export const MAX_MESSAGE_TEXT = 500;

/**
 * The longest value (in characters) an own message quotes from a server answer or from
 * the user's input: an id, a filter key, a Content-Type, a redirect target. A longer one
 * is cut and ends in "…", so a library caller's `err.message` stays bounded too.
 */
export const MAX_QUOTED_LENGTH = 200;

/**
 * `text` cut to `max` characters (code points, so never inside a surrogate pair; default
 * {@link MAX_MESSAGE_TEXT}), marked with "…" when cut.
 */
export function cutForMessage(text: string, max: number = MAX_MESSAGE_TEXT): string {
  let units = 0;
  for (let chars = 0; units < text.length && chars < max; chars++) {
    units += (text.codePointAt(units) as number) > 0xffff ? 2 : 1;
  }
  return units >= text.length ? text : `${text.slice(0, units)}…`;
}

/**
 * A value an own message quotes from the user's input: its userinfo redacted
 * ({@link redactUrl}) before it is cut at {@link MAX_QUOTED_LENGTH}, so the cut can't
 * leave part of a password behind without the `@` that marks it.
 */
export function quoteValue(value: string): string {
  return cutForMessage(redactUrl(value), MAX_QUOTED_LENGTH);
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

/**
 * `text` with every lone surrogate (half of a character) replaced by U+FFFD, like
 * `String.prototype.toWellFormed` (ES2024, so not in this package's `lib`).
 */
export function toWellFormed(text: string): string {
  return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
}

/** Base class for every error originating from this client. */
export class AwError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Maximum URL length echoed into a human-readable error message. */
const MAX_URL_IN_MESSAGE = 200;

/**
 * Shorten an overly long URL for display, keeping head and tail context. Neither cut
 * lands inside a surrogate pair (a URL that doesn't parse is shown as given).
 */
function truncateUrl(url: string): string {
  if (url.length <= MAX_URL_IN_MESSAGE) return url;
  const head = cutText(url, MAX_URL_IN_MESSAGE - 40);
  const from = url.length - 20;
  const tail = url.slice(isHighSurrogate(url.charCodeAt(from - 1)) ? from + 1 : from);
  return `${head}…[${url.length} chars]…${tail}`;
}

/**
 * The API responded with a non-2xx status code. `detail` holds a human-readable
 * message extracted from the response body when one is present — for
 * abgeordnetenwatch that is the `meta.status_message` field. For a 3xx that was not
 * followed (not a followable status, a malformed Location, or past `maxRedirects`),
 * `location` holds the redirect target (absolute, sanitised, userinfo redacted) and
 * the message names it.
 */
export class AwApiError extends AwError {
  readonly status: number;
  readonly detail: string | undefined;
  readonly url: string;
  readonly method: string;
  readonly body: string;
  readonly location: string | undefined;
  /** How many times the engine retried the request before giving up (0 when it did not). */
  readonly retries: number;
  /**
   * The wait the server asked for in `Retry-After` (milliseconds) when it was longer than
   * the engine waits (`MAX_RETRY_AFTER_MS`), so the request was not retried; else undefined.
   */
  readonly retryAfterMs: number | undefined;

  constructor(args: {
    status: number;
    url: string;
    method: string;
    body: string;
    detail?: string;
    location?: string;
    retries?: number;
    retryAfterMs?: number;
    maxRetryAfterMs?: number;
  }) {
    // The URL is shown without userinfo: a credential in --base-url must not leak.
    const url = redactUrl(args.url);
    const parts: string[] = [];
    if (args.detail) parts.push(args.detail);
    if (args.status >= 300 && args.status < 400) {
      parts.push(
        args.location
          ? `redirect to ${cutForMessage(args.location, MAX_QUOTED_LENGTH)} not followed`
          : "redirect not followed (no Location header)",
      );
    }
    if (args.retryAfterMs !== undefined) {
      // Say why the retries the caller asked for never ran: the server asked for a wait
      // longer than the engine sleeps, and retrying earlier would land inside that window.
      const wait = Math.ceil(args.retryAfterMs / 1000);
      const cap =
        args.maxRetryAfterMs === undefined ? "" : `, longer than the ${args.maxRetryAfterMs / 1000} s the client waits`;
      parts.push(`the server asked to retry after ${wait} s${cap}; not retried — try again after that`);
    }
    const detailPart = parts.length > 0 ? `: ${parts.join("; ")}` : "";
    const retries = args.retries ?? 0;
    // Say that the status persisted through retries, so a user knows whether raising
    // --max-retries could help.
    const retryPart = retries > 0 ? ` (after ${retries} ${retries === 1 ? "retry" : "retries"})` : "";
    // Cap the URL in the human-readable message so a pathologically long URL
    // (e.g. a huge filter that triggers an HTTP 414) doesn't dump multiple KB to
    // stderr. The full URL remains available on `this.url` for programmatic use.
    super(`HTTP ${args.status} for ${args.method} ${truncateUrl(url)}${detailPart}${retryPart}`);
    this.status = args.status;
    this.url = url;
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
    this.location = args.location;
    this.retries = retries;
    this.retryAfterMs = args.retryAfterMs;
  }

  /** True for statuses the API documents as transient and retry-able. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503;
  }
}

/**
 * An input the library rejects before sending any request: a bad option, id,
 * filter or parameter value. The message reads `Invalid <name>: <reason>`. The CLI
 * maps it to its usage-error exit code (2).
 */
export class AwValidationError extends AwError {}

/** A transport-level failure (DNS, connection reset, timeout, ...). */
export class AwNetworkError extends AwError {}

/** The response body could not be parsed as the expected JSON shape. */
export class AwParseError extends AwError {}
