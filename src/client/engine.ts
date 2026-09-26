// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import { nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import { AwApiError, AwError, AwNetworkError, AwParseError, redactUrl } from "./errors.js";

export const DEFAULT_BASE_URL = "https://www.abgeordnetenwatch.de";
const DEFAULT_USER_AGENT = "abgeordnetenwatch-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

export interface EngineOptions {
  /** Base URL of the API. Defaults to https://www.abgeordnetenwatch.de */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /** Value of the User-Agent header. */
  userAgent?: string;
  /**
   * Extra headers sent on every request to the configured origin. When a redirect
   * crosses to a different origin, all of them are dropped (only the engine's own
   * Accept and User-Agent go along), so no credential — Authorization,
   * Proxy-Authorization, Cookie, X-API-Key, X-Auth-Token or any other — leaks to an
   * arbitrary host named in Location.
   */
  headers?: Record<string, string>;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps (0 disables; capped at `MAX_TIMEOUT_MS`, 2^31 - 1 ms).
   */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses. Each waits the
   * response's `Retry-After` (up to `MAX_RETRY_AFTER_MS`; a longer one is not
   * retried), or else `retryDelayMs * attempt`.
   */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds (grows linearly: 1 s, 2 s, ... by
   * default). The upstream rate limiter answers a burst with 429s and no
   * Retry-After for about 1–2 s, so the default outlasts that window.
   */
  retryDelayMs?: number;
  /**
   * Number of HTTP redirects (301/302/303/307/308) to follow. Defaults to 5. Any
   * other 3xx, one with a missing or malformed Location, and one past this limit
   * surface as an AwApiError naming the target.
   */
  maxRedirects?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/**
 * The redirect statuses the engine follows. 300 (a choice for the user), 304 (a
 * cache answer to a conditional request this client never sends) and 305/306
 * (deprecated) are not redirects to follow; they surface as an AwApiError.
 */
const FOLLOWED_REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Default base backoff for a 429/503 without Retry-After. abgeordnetenwatch.de
 * rate-limits bursts with a bare 429 and recovers after about 1–2 s, so retries at
 * 1 s and 2 s (3 s in all with the default two retries) outlast the window;
 * 200 ms and 400 ms did not.
 */
const DEFAULT_RETRY_DELAY_MS = 1_000;

// The headers the engine sets itself, under the exact keys it uses. They are the
// only ones that follow a cross-origin redirect.
const ENGINE_HEADERS = new Set(["Accept", "User-Agent"]);

/**
 * A copy of `headers` without any caller-supplied header (used on cross-origin
 * redirects). A list of known credential headers is never complete
 * (Proxy-Authorization, X-Auth-Token, ...), so only the engine's own
 * non-credential headers are kept.
 */
function engineHeadersOnly(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => ENGINE_HEADERS.has(key)));
}

/**
 * Strip control characters (all C0/C1 except tab and newline, plus DEL) out of a
 * string that originates in an attacker-controlled response — the error `detail`
 * and the echoed Content-Type. `JSON.parse` decodes a `\u001b` escape in an
 * error body into a real ESC byte, so without this a hostile/MITM'd endpoint could drive ANSI/OSC
 * escape sequences into the user's terminal when the message is printed to stderr.
 * The CLI's JSON output is escaped separately (`escapeControlChars` in
 * `cli/shared.ts`: `JSON.stringify` alone leaves DEL and the C1 range raw), so
 * this only needs to cover text that flows into an error message.
 */
function sanitizeServerText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Validate the configured base URL up front. Without this the only scheme check
 * lived in the transport, which rejects the *fully built* request URL — so a bad
 * `--base-url ftp://x` produced a message echoing `ftp://x/api/v2/...` rather than
 * the value the user actually passed. Throwing here keeps the message about the
 * base URL itself.
 */
function assertValidBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new AwError(`Invalid base URL "${redactUrl(baseUrl)}".`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AwError(
      `Unsupported base URL scheme "${parsed.protocol}" in "${redactUrl(baseUrl)}"; only http and https are supported.`,
    );
  }
  // Request paths are appended to the base URL as a string, so a `?` or `#` would
  // swallow every path: `http://h/?x=1` requests `/?x=1/api/v2/...` and
  // `http://h/#f` requests `/`.
  if (/[?#]/.test(baseUrl)) {
    throw new AwNetworkError(`Base URL must not contain a query or fragment: ${redactUrl(baseUrl)}`);
  }
}

/**
 * Longest `Retry-After` the engine waits out before retrying a 429/503. When the
 * server asks for longer, the engine does not retry at all and surfaces the error at
 * once: retrying early would only land inside the window the server asked us to wait
 * out, and a hostile value must not stall the CLI.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** An IMF-fixdate (RFC 9110 §5.6.7), the one HTTP-date form senders must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` header into a delay in milliseconds (RFC 9110 §10.2.3):
 * either delay-seconds (`"120"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`,
 * turned into the time left from `now`; a date in the past gives 0).
 *
 * Returns `undefined` when the header is absent or malformed — negative (`"-1"`),
 * fractional (`"1.5"`), padded inside, any other date format — so the caller falls
 * back to its own backoff. The strict patterns matter: `Date.parse` alone would
 * read `"1.5"` as a date in 2001 and retry at once.
 */
export function parseRetryAfter(
  header: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!IMF_FIXDATE.test(value)) return undefined;
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

export class RequestEngine {
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    assertValidBaseUrl(this.baseUrl);
    this.transport = options.transport ?? nodeHttpTransport;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.extraHeaders = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.maxRedirects = options.maxRedirects ?? 5;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.sleep = options.sleep ?? realSleep;
  }

  /** Build a fully-qualified URL from a path and optional query parameters. */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /** Perform a request with Accept negotiation and transient-error retries. */
  async request(
    method: string,
    path: string,
    options: { query?: QueryParams; accept: string } = { accept: "application/json" },
  ): Promise<RawResponse> {
    let url = this.buildUrl(path, options.query);
    let headers: Record<string, string> = {
      ...this.extraHeaders,
      Accept: options.accept,
      "User-Agent": this.userAgent,
    };

    let attempt = 0;
    let redirects = 0;
    // attempts = initial try + maxRetries (redirects are counted separately)
    for (;;) {
      const response = await this.transport({
        method,
        url,
        headers,
        timeoutMs: this.timeoutMs,
        ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
      });

      const status = response.status;
      const retryable = status === 429 || status === 503;
      if (retryable && attempt < this.maxRetries) {
        // Honour Retry-After; without a usable one, back off linearly. A Retry-After
        // beyond MAX_RETRY_AFTER_MS is not retried: the error below surfaces at once.
        const retryAfter = parseRetryAfter(response.headers["retry-after"]);
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          await this.sleep(retryAfter ?? this.retryDelayMs * attempt);
          continue;
        }
      }

      // Follow redirects, resolving the Location relative to the current URL.
      // abgeordnetenwatch 301-redirects a collection path without its trailing
      // slash (`/api/v2` -> `/api/v2/`), so this matters in practice.
      const location = response.headers["location"];
      const nextUrl =
        FOLLOWED_REDIRECTS.has(status) && redirects < this.maxRedirects
          ? resolveLocation(location, url)
          : undefined;
      if (nextUrl !== undefined) {
        // Credential-strip guard: if the redirect target is a different origin,
        // drop every caller-supplied header so no credential is ever sent to an
        // arbitrary host named in Location. Compare full origin (scheme + host +
        // port), not just host, so a same-host https->http *downgrade* also
        // strips — otherwise credentials would cross the wire in cleartext.
        if (nextUrl.origin !== new URL(url).origin) {
          headers = engineHeadersOnly(headers);
        }
        url = nextUrl.toString();
        redirects += 1;
        continue;
      }
      // Any other 3xx — not a followed status, no usable Location, or past
      // maxRedirects — falls through and surfaces as an AwApiError naming the target.

      const contentType = String(response.headers["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, response.body, location);
      }

      return { data: response.body, contentType, status };
    }
  }

  /** Perform a GET expecting JSON and parse it into `T`. */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    const res = await this.request("GET", path, { query, accept: "application/json" });
    // Guard against a 2xx response that is not actually JSON (e.g. a captive
    // portal or a wildcard-DNS host returning an HTML page). The header may carry
    // a charset (e.g. "application/json; charset=utf-8"), so match the media
    // type prefix only.
    const mediaType = (res.contentType.split(";", 1)[0] ?? "").trim().toLowerCase();
    if (mediaType && mediaType !== "application/json" && !mediaType.endsWith("+json")) {
      throw new AwParseError(
        `Unexpected content type "${sanitizeServerText(res.contentType)}" from ${path} (expected JSON).`,
      );
    }
    const text = res.data.toString("utf8");
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new AwParseError(`Failed to parse JSON response from ${path}`, { cause });
    }
  }

  private toApiError(
    method: string,
    url: string,
    status: number,
    body: Buffer,
    locationHeader?: string,
  ): AwApiError {
    const text = body.toString("utf8");
    let detail: string | undefined;
    try {
      // abgeordnetenwatch error bodies carry the message at meta.status_message;
      // fall back to common detail/message fields for robustness.
      const parsed = JSON.parse(text) as {
        meta?: { status_message?: unknown };
        detail?: unknown;
        message?: unknown;
      };
      const metaMsg = parsed?.meta?.status_message;
      if (typeof metaMsg === "string" && metaMsg.length > 0) detail = metaMsg;
      else if (typeof parsed?.detail === "string") detail = parsed.detail;
      else if (typeof parsed?.message === "string") detail = parsed.message;
    } catch {
      // Non-JSON error body; leave detail undefined.
    }
    // `detail` came from the response body; strip control characters so a hostile
    // endpoint cannot inject terminal escape sequences via the stderr error message.
    if (detail !== undefined) detail = sanitizeServerText(detail);
    // Name the target of a redirect that was not followed.
    const location =
      status >= 300 && status < 400 && locationHeader ? redirectTarget(url, locationHeader) : undefined;
    return new AwApiError({ status, url, method, body: text, detail, location });
  }
}

/** Resolve a Location header against the current URL; undefined if missing or malformed. */
function resolveLocation(location: string | undefined, base: string): URL | undefined {
  if (location === undefined || location === "") return undefined;
  try {
    return new URL(location, base);
  } catch {
    return undefined;
  }
}

/**
 * The absolute, printable form of a `Location` header: resolved against the request
 * URL, userinfo redacted, control characters stripped (it is server text bound for
 * stderr). An unparseable value is shown sanitised as it came.
 */
function redirectTarget(requestUrl: string, location: string): string | undefined {
  const resolved = resolveLocation(location, requestUrl);
  const clean = sanitizeServerText(resolved ? redactUrl(resolved.href) : location).trim();
  return clean === "" ? undefined : clean;
}
