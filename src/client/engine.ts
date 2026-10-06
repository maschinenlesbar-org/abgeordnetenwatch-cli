// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import {
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  sizeLimitMessage,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  AwApiError,
  AwError,
  AwNetworkError,
  AwParseError,
  AwValidationError,
  credentialsIn,
  redactCredentials,
  redactUrl,
} from "./errors.js";
import {
  assertValid,
  baseUrlProblem,
  headerNameProblem,
  headerValueProblem,
} from "./validate.js";

export const DEFAULT_BASE_URL = "https://www.abgeordnetenwatch.de";
const DEFAULT_USER_AGENT = "abgeordnetenwatch-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

/**
 * Options for {@link RequestEngine} and the client. The numeric options must be
 * integers within their documented range; anything else (negative, fractional,
 * NaN, Infinity, too large, not a number) makes the constructor throw an
 * AwValidationError, as does an options value that is not an object, a `transport`
 * or `sleep` that is not a function, and `headers` that are not a plain object.
 */
export interface EngineOptions {
  /**
   * Base URL of the API. Defaults to https://www.abgeordnetenwatch.de. Must be an
   * absolute http(s) URL without a query, fragment or surrounding whitespace
   * (baseUrlProblem); anything else throws at construction.
   */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /**
   * Value of the User-Agent header. Must not be blank, nor contain control
   * characters (tab aside) or characters above U+00FF; such a value throws
   * AwValidationError at construction.
   */
  userAgent?: string;
  /**
   * Extra headers sent on every request to the configured origin. When a redirect
   * the engine follows crosses to a different origin, all of them are dropped (only
   * the engine's own Accept and User-Agent go along), so no credential —
   * Authorization, Proxy-Authorization, Cookie, X-API-Key, X-Auth-Token or any
   * other — leaks to an arbitrary host named in Location. That holds only while the
   * transport leaves redirects to the engine (`HttpRequest.redirect` is "manual"); a
   * response whose `HttpResponse.url` lies on another origin is rejected. Names must
   * be HTTP tokens and values follow the `userAgent` rule; anything else throws
   * AwValidationError at construction.
   */
  headers?: Record<string, string>;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps (0 disables; at most `MAX_TIMEOUT_MS`, 2^31 - 1 ms). Enforced by
   * the engine for every transport.
   */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses and for a GET whose
   * connection was reset (see {@link isTransientNetworkError}), 0..`MAX_RETRIES` (10).
   * Each waits `retryDelayMs * attempt`, or a 429/503's `Retry-After` when that is
   * longer (up to `MAX_RETRY_AFTER_MS`; a longer one is not retried, and the AwApiError
   * says so and carries it as `retryAfterMs`).
   */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds (grows linearly: 1 s, 2 s, ... by
   * default). The upstream rate limiter answers a burst with 429s and no
   * Retry-After for about 1–2 s, so the default outlasts that window. At most
   * `MAX_RETRY_AFTER_MS`. It is also the floor under a `Retry-After`: the header can
   * lengthen a wait, never shorten it.
   */
  retryDelayMs?: number;
  /**
   * Number of HTTP redirects (301/302/303/307/308) to follow, 0..20. Defaults to 5. Any
   * other 3xx, one with a missing or malformed Location, and one past this limit
   * surface as an AwApiError naming the target.
   */
  maxRedirects?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   * Enforced by the engine for every transport.
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

/** Why `value` is not a usable HttpResponse, or undefined when it is. */
function responseProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const r = value as Partial<Record<"status" | "headers" | "body", unknown>>;
  if (typeof r.status !== "number" || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) {
    return "status is not an HTTP status code";
  }
  if (typeof r.headers !== "object" || r.headers === null || Array.isArray(r.headers)) return "headers is not an object";
  if (bodyBytes(r.body) === undefined) return "body is not a Buffer, Uint8Array, other ArrayBuffer view or ArrayBuffer";
  return undefined;
}

/**
 * The response body as a Buffer (a view, no copy): a Buffer, any ArrayBuffer view (a
 * Uint8Array from fetch, a DataView) or an ArrayBuffer/SharedArrayBuffer — checked by internal
 * slot, not `instanceof`, so a value from another realm (a vm context, a Jest test) counts.
 * Undefined for anything else.
 */
function bodyBytes(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") return Buffer.from(value as ArrayBuffer);
  return undefined;
}

/**
 * The response headers as a plain record with lower-case names. Node's transport
 * lower-cases them; a custom one may not (`Retry-After`, `Location`, `Content-Type`), and
 * a fetch transport naturally returns its `Headers` object, which has no plain properties.
 * Such an object (anything with `get` and `forEach`: `Headers`, a `Map`) is copied.
 */
function plainHeaders(headers: object): Record<string, string | string[] | undefined> {
  const h = headers as { get?: unknown; forEach?: unknown };
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    const record: Record<string, string> = {};
    (h.forEach as (cb: (value: string, name: string) => void) => void).call(headers, (value, name) => {
      record[String(name).toLowerCase()] = value;
    });
    return record;
  }
  const record: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    record[name.toLowerCase()] = value;
  }
  return record;
}

/** The first value of a header (a repeated one arrives as an array). */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Error codes of a connection that broke off mid-request: Node's (`socket hang up` is
 * ECONNRESET) and undici's (`fetch failed` with cause UND_ERR_SOCKET, "other side closed").
 */
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET"]);

/** True when `err` or an error in its `cause` chain has a transient connection code. */
function hasTransientCode(err: unknown, depth = 0): boolean {
  if (typeof err !== "object" || err === null || depth > 4) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return hasTransientCode((err as { cause?: unknown }).cause, depth + 1);
}

/**
 * True for an AwNetworkError caused by a reset or aborted connection, which the engine
 * retries — whichever transport raised it (a Node error, fetch's TypeError with an undici
 * cause). A refused connection, a DNS failure or a timeout is not retried.
 */
export function isTransientNetworkError(err: unknown): boolean {
  return err instanceof AwNetworkError && hasTransientCode(err.cause);
}

/**
 * Longest server text (in characters) an error message shows; `AwApiError.body` keeps
 * the whole body. A proxy's 200 kB error page would otherwise flood the terminal.
 */
export const MAX_MESSAGE_TEXT = 500;

/** `text` cut to {@link MAX_MESSAGE_TEXT} characters, marked with "…" when cut. */
export function cutForMessage(text: string): string {
  const chars = [...text];
  return chars.length <= MAX_MESSAGE_TEXT ? text : `${chars.slice(0, MAX_MESSAGE_TEXT).join("")}…`;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Validate a base URL (baseUrlProblem) and throw AwValidationError when it is not
 * usable: a configuration error, never an AwNetworkError, which a caller may retry
 * as transient. The userinfo is redacted from the message. The engine runs it on the
 * raw configured value, before it strips trailing slashes, so a bad
 * `--base-url ftp://x` names the value the user passed rather than
 * `ftp://x/api/v2/...` from the transport.
 */
export function assertValidBaseUrl(baseUrl: string): void {
  const reason = baseUrlProblem(baseUrl);
  if (reason === undefined) return;
  throw new AwValidationError(`Invalid base URL "${redactUrl(String(baseUrl))}": ${reason}`);
}

/**
 * Longest `Retry-After` the engine waits out before retrying a 429/503. When the
 * server asks for longer, the engine does not retry at all and surfaces the error at
 * once, naming the requested wait (`AwApiError.retryAfterMs`): retrying early would only land inside the window the server asked us to wait
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

/** Most automatic retries a caller may ask for (the CLI's --max-retries shares it). */
export const MAX_RETRIES = 10;

/** Most redirects a caller may let the engine follow (the Fetch standard's limit). */
const MAX_REDIRECTS = 20;

/**
 * Read a numeric engine option: `undefined` gives the default; anything but an
 * integer in [0, max] throws an AwValidationError. Without this a negative or NaN
 * `timeoutMs` silently disabled the timeout, and `maxResponseBytes: -1` the size cap.
 */
function intOption(name: string, value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new AwValidationError(
      `Invalid option ${name}: expected an integer from 0 to ${max}, got ${String(value)}.`,
    );
  }
  return value;
}

export class RequestEngine {
  // A real private field (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show it, so a password in the base URL can't be
  // logged by accident. Messages show request URLs through redactUrl.
  readonly #baseUrl: string;
  /** The base URL's userinfo, raw and percent-decoded, for scrubbing server and transport text. */
  readonly #credentials: string[];
  private readonly transport: Transport;
  private readonly userAgent: string;
  // Caller headers may hold credentials (Authorization for a proxy): private, like the base URL.
  readonly #extraHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new AwValidationError("Invalid options: expected an object of engine options.");
    }
    for (const name of ["transport", "sleep"] as const) {
      if (options[name] !== undefined && typeof options[name] !== "function") {
        throw new AwValidationError(`Invalid option ${name}: expected a function.`);
      }
    }
    const rawHeaders: unknown = options.headers;
    if (
      rawHeaders !== undefined &&
      (typeof rawHeaders !== "object" || rawHeaders === null || Array.isArray(rawHeaders))
    ) {
      throw new AwValidationError("Invalid option headers: expected an object of header names and values.");
    }
    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    assertValidBaseUrl(baseUrl);
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#credentials = credentialsIn(this.#baseUrl).flatMap((raw) => {
      try {
        return [raw, decodeURIComponent(raw)];
      } catch {
        return [raw];
      }
    });
    this.transport = options.transport ?? nodeHttpTransport;
    // Header names and values are checked here, so a bad one is an AwValidationError
    // at construction rather than a raw TypeError (or an injected header) later.
    this.userAgent =
      options.userAgent === undefined
        ? DEFAULT_USER_AGENT
        : assertValid("userAgent", options.userAgent, headerValueProblem);
    this.#extraHeaders = { ...(options.headers ?? {}) };
    for (const [name, value] of Object.entries(this.#extraHeaders)) {
      assertValid(`header name ${JSON.stringify(name)}`, name, headerNameProblem);
      assertValid(`header ${JSON.stringify(name)}`, value, headerValueProblem);
    }
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, 30_000, MAX_TIMEOUT_MS);
    this.maxRetries = intOption("maxRetries", options.maxRetries, 2, MAX_RETRIES);
    this.retryDelayMs = intOption(
      "retryDelayMs",
      options.retryDelayMs,
      DEFAULT_RETRY_DELAY_MS,
      MAX_RETRY_AFTER_MS,
    );
    this.maxRedirects = intOption("maxRedirects", options.maxRedirects, 5, MAX_REDIRECTS);
    this.maxResponseBytes = intOption(
      "maxResponseBytes",
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      Number.MAX_SAFE_INTEGER,
    );
    this.sleep = options.sleep ?? realSleep;
  }

  /**
   * `text` without the base URL's credentials: server text (an error body that echoes the
   * request URL) and transport text (fetch's "Request cannot be constructed from a URL that
   * includes credentials: <url>") can carry them.
   */
  private scrub(text: string): string {
    return this.#credentials.length === 0 ? text : redactCredentials(text, this.#credentials);
  }

  /**
   * A transport failure as the `cause` of the error the engine raises: the original when its
   * text carries no credentials, otherwise a copy with them scrubbed (message, `code` and the
   * cause chain kept), so logging the error with its causes can't reveal the base URL's
   * password.
   */
  private scrubCause(cause: unknown, depth = 0): unknown {
    if (this.#credentials.length === 0 || depth > 5) return cause;
    if (typeof cause === "string") return this.scrub(cause);
    if (!(cause instanceof Error)) return cause;
    const inner = this.scrubCause(cause.cause, depth + 1);
    const message = this.scrub(cause.message);
    if (message === cause.message && inner === cause.cause && !this.scrub(cause.stack ?? "").includes("***@")) return cause;
    const copy = new Error(message, inner === undefined ? undefined : { cause: inner });
    copy.name = cause.name;
    const code = (cause as { code?: unknown }).code;
    if (code !== undefined) Object.assign(copy, { code });
    return copy;
  }

  /** Build a fully-qualified URL from a path and optional query parameters. */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.#baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /**
   * Call the transport under the overall deadline (`timeoutMs`): the request gets an
   * AbortSignal that fires at the deadline, and the call rejects then whether the transport
   * stops or not — a custom transport (fetch, a node:http wrapper) that ignores `timeoutMs`
   * can't hang the caller. A synchronous throw becomes a rejection.
   */
  private async callTransport(request: HttpRequest): Promise<HttpResponse> {
    const call = (signal?: AbortSignal): Promise<HttpResponse> =>
      Promise.resolve().then(() => this.transport(signal === undefined ? request : { ...request, signal }));
    if (this.timeoutMs === 0) return call();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new AwNetworkError(`Request timed out after ${this.timeoutMs}ms`);
        controller.abort(err);
        reject(err);
      }, Math.min(this.timeoutMs, MAX_TIMEOUT_MS));
    });
    try {
      return await Promise.race([call(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Perform a request with Accept negotiation and transient-error retries. */
  async request(
    method: string,
    path: string,
    options: { query?: QueryParams; accept: string } = { accept: "application/json" },
  ): Promise<RawResponse> {
    // The transport never sees the base URL's userinfo: the engine sends it as an
    // Authorization header, per hop, so a redirect to the same origin (relative or
    // absolute) keeps it and one to another origin or scheme drops it. A transport such
    // as fetch also refuses a URL with credentials outright.
    let url = withoutUserinfo(this.buildUrl(path, options.query));
    let headers: Record<string, string> = {
      ...this.#extraHeaders,
      Accept: options.accept,
      "User-Agent": this.userAgent,
    };
    // A caller's own Authorization header wins, as it did when Node built the header
    // from the URL.
    const authorization = basicAuthorization(this.#baseUrl);
    if (authorization !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === "authorization")) {
      headers["Authorization"] = authorization;
    }
    /** Why a redirect dropped the credentials, for a 401/403 message. */
    let dropped: string | undefined;

    // Only an idempotent request is sent again after a reset: request() is public, and a
    // POST re-sent may be applied twice. The client itself sends GETs only.
    const idempotent = /^(GET|HEAD)$/i.test(method);
    let attempt = 0;
    let redirects = 0;
    // attempts = initial try + maxRetries (redirects are counted separately)
    for (;;) {
      let response: HttpResponse;
      try {
        response = await this.callTransport({
          method,
          url,
          headers,
          timeoutMs: this.timeoutMs,
          redirect: "manual",
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
        // A connection the server (or a proxy) reset is the network-level twin of a 503:
        // retry an idempotent request, whichever transport reported it. Timeouts are not
        // retried — a slow upstream should not be asked again at once.
        if (idempotent && hasTransientCode(cause) && attempt < this.maxRetries) {
          attempt += 1;
          await this.sleep(this.retryDelayMs * attempt);
          continue;
        }
        // The default transport rejects with AwNetworkError only; an injected one may
        // throw anything, and its text may carry the request URL with the base URL's
        // password (fetch refuses a URL with credentials and quotes it). Keep the
        // library's error contract — every failure is an AwError — and scrub that text.
        if (cause instanceof AwError && !(cause instanceof AwNetworkError)) throw cause;
        if (cause instanceof AwNetworkError && this.scrub(cause.message) === cause.message) throw cause;
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new AwNetworkError(
          `${method} ${redactUrl(url)} failed: ${sanitizeServerText(this.scrub(reason))}`,
          { cause: this.scrubCause(cause) },
        );
      }

      // An injected transport may resolve with anything; a malformed HttpResponse would
      // otherwise surface below as a raw TypeError (or, with no status, as success),
      // outside the AwError contract.
      const invalid = responseProblem(response);
      if (invalid !== undefined) {
        throw new AwNetworkError(
          `${method} ${redactUrl(url)} failed: the transport returned an invalid response (${invalid}).`,
        );
      }
      // A transport must not follow redirects itself (`redirect: "manual"`): one that did
      // (fetch's default) may have carried caller headers to another host, and the answer
      // is not the one asked for. Reject it when it says so (`url`).
      const finalUrl = (response as { url?: unknown }).url;
      if (typeof finalUrl === "string" && finalUrl !== "" && originOf(finalUrl) !== originOf(url)) {
        throw new AwNetworkError(
          `${method} ${redactUrl(url)} failed: the transport followed a redirect to another origin ` +
            `(${sanitizeServerText(redactUrl(this.scrub(finalUrl)))}); a transport must not follow redirects ` +
            `(HttpRequest.redirect is "manual").`,
        );
      }

      const status = response.status;
      const responseHeaders = plainHeaders(response.headers);
      // fetch gives a Uint8Array; view it as a Buffer (no copy), which the decoders expect.
      const body = bodyBytes(response.body) as Buffer;
      // The size cap holds whatever the transport did: the default one aborts early, a custom
      // one may have read everything.
      if (this.maxResponseBytes > 0 && body.byteLength > this.maxResponseBytes) {
        throw new AwNetworkError(`${method} ${redactUrl(url)} failed: ${sizeLimitMessage(this.maxResponseBytes)}`);
      }
      const retryable = status === 429 || status === 503;
      // A Retry-After beyond MAX_RETRY_AFTER_MS is not retried: the error below surfaces at
      // once and names the wait the server asked for.
      const retryAfter = retryable ? parseRetryAfter(responseHeaders["retry-after"]) : undefined;
      const tooLong = retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_MS;
      if (retryable && !tooLong && attempt < this.maxRetries) {
        attempt += 1;
        // Back off linearly from retryDelayMs. A Retry-After can ask for longer, never for
        // less: `Retry-After: 0` or a date in the past turned the retries into a zero-delay
        // burst against a server that had just asked for less load.
        const backoff = this.retryDelayMs * attempt;
        await this.sleep(retryAfter === undefined ? backoff : Math.max(retryAfter, backoff));
        continue;
      }

      // Follow redirects, resolving the Location relative to the current URL.
      // abgeordnetenwatch 301-redirects a collection path without its trailing
      // slash (`/api/v2` -> `/api/v2/`), so this matters in practice.
      const location = headerValue(responseHeaders["location"]);
      const nextUrl =
        FOLLOWED_REDIRECTS.has(status) && redirects < this.maxRedirects
          ? resolveLocation(location, url)
          : undefined;
      if (nextUrl !== undefined) {
        // Only http(s) is followed, checked here and not only by the built-in transport:
        // a custom transport must never be handed a file:, data: or javascript: URL.
        if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
          throw new AwNetworkError(
            `Refusing to follow redirect to unsupported protocol "${nextUrl.protocol}" from ${method} ${redactUrl(url)}`,
          );
        }
        // Userinfo in a Location is not used: credentials come from the base URL only,
        // as the Authorization header, never from a server.
        nextUrl.username = "";
        nextUrl.password = "";
        // Credential-strip guard: if the redirect target is a different origin,
        // drop every caller-supplied header (and the base URL's Authorization) so no
        // credential is ever sent to an arbitrary host named in Location. Compare full
        // origin (scheme + host + port), not just host, so a same-host https->http
        // *downgrade* also strips — otherwise credentials would cross the wire in
        // cleartext. The same origin keeps them, whether the Location is relative or
        // absolute.
        const from = new URL(url);
        if (nextUrl.origin !== from.origin) {
          const hadAuthorization = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
          if (hadAuthorization && dropped === undefined) {
            dropped =
              from.protocol === "http:" && nextUrl.protocol === "https:" && from.hostname === nextUrl.hostname
                ? "the server redirected http→https, which dropped the credentials; use an https base URL"
                : `the redirect to ${nextUrl.origin} dropped the credentials (they are sent to their own origin only)`;
          }
          headers = engineHeadersOnly(headers);
        }
        url = nextUrl.toString();
        redirects += 1;
        continue;
      }
      // Any other 3xx — not a followed status, no usable Location, or past
      // maxRedirects — falls through and surfaces as an AwApiError naming the target.

      const contentType = String(headerValue(responseHeaders["content-type"]) ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(
          method,
          url,
          status,
          body,
          location,
          status === 401 || status === 403 ? dropped : undefined,
          { retries: attempt, ...(tooLong ? { retryAfterMs: retryAfter } : {}) },
        );
      }

      return { data: body, contentType, status };
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
    const text = decodeBody(res.data, res.contentType, path);
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
    locationHeader: string | undefined,
    hint: string | undefined,
    retry: { retries: number; retryAfterMs?: number },
  ): AwApiError {
    const text = this.scrub(body.toString("utf8"));
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
    if (detail !== undefined) detail = cutForMessage(sanitizeServerText(detail));
    if (hint !== undefined) detail = detail === undefined ? hint : `${detail}; ${hint}`;
    // Name the target of a redirect that was not followed.
    const location =
      status >= 300 && status < 400 && locationHeader
        ? redirectTarget(url, this.scrub(locationHeader))
        : undefined;
    return new AwApiError({
      status,
      url,
      method,
      body: text,
      detail,
      location,
      retries: retry.retries,
      ...(retry.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: retry.retryAfterMs, maxRetryAfterMs: MAX_RETRY_AFTER_MS }),
    });
  }
}

/**
 * Decode a response body by the charset of its Content-Type (UTF-8 when none is
 * given, as JSON requires). A leading byte-order mark is dropped: TextDecoder does
 * that by default, where Buffer#toString kept it and JSON.parse then failed. The
 * upstream sends UTF-8; this matters for proxies and mirrors that re-encode.
 */
function decodeBody(body: Buffer, contentType: string, path: string): string {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    throw new AwParseError(
      `Unsupported response charset "${sanitizeServerText(charset)}" from ${path}.`,
    );
  }
  return decoder.decode(body);
}

/** `url` without its userinfo (the engine sends that as an Authorization header). */
function withoutUserinfo(url: string): string {
  const parsed = new URL(url);
  if (parsed.username === "" && parsed.password === "") return url;
  const [userinfo] = credentialsIn(url);
  return userinfo === undefined ? url : url.replace(`://${userinfo}@`, "://");
}

/**
 * The `Authorization` header for a URL's userinfo (`Basic base64(user:password)`, both
 * percent-decoded, as Node's own http client builds it), or undefined without userinfo.
 */
function basicAuthorization(url: string): string | undefined {
  const parsed = new URL(url);
  if (parsed.username === "" && parsed.password === "") return undefined;
  const pair = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`;
  return `Basic ${Buffer.from(pair, "utf8").toString("base64")}`;
}

/** The origin (scheme, host, port) of a URL, or the value itself if it doesn't parse. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
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
