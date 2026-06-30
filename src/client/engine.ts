// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import { nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import { AwApiError, AwError, AwParseError } from "./errors.js";

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
   * Extra headers sent on every request. Credential-bearing headers
   * (Authorization, Cookie, X-API-Key) are automatically stripped when a
   * redirect crosses to a different origin, so they never leak to an arbitrary
   * host named in Location.
   */
  headers?: Record<string, string>;
  /** Per-request timeout in milliseconds (0 disables). */
  timeoutMs?: number;
  /** Number of automatic retries for transient (429/503) responses. */
  maxRetries?: number;
  /** Base backoff between retries in milliseconds (grows linearly). */
  retryDelayMs?: number;
  /** Number of HTTP redirects (301/302/303/307/308) to follow. Defaults to 5. */
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

// Headers that carry credentials and must never follow a cross-origin redirect.
// Matched case-insensitively against the live header keys.
const SENSITIVE_HEADERS = ["authorization", "cookie", "x-api-key"];

/** Remove credential-bearing headers in place (used on cross-origin redirects). */
function stripSensitiveHeaders(headers: Record<string, string>): void {
  for (const key of Object.keys(headers)) {
    if (SENSITIVE_HEADERS.includes(key.toLowerCase())) delete headers[key];
  }
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
    throw new AwError(`Invalid base URL "${baseUrl}".`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AwError(
      `Unsupported base URL scheme "${parsed.protocol}" in "${baseUrl}"; only http and https are supported.`,
    );
  }
}

// Upper bound on how long a Retry-After header may make us wait, so a pathological
// or hostile value (e.g. "Retry-After: 86400") cannot hang the CLI for hours.
const MAX_RETRY_AFTER_MS = 30_000;

/** Coerce a possibly-repeated header value to a single string (or undefined). */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Parse a Retry-After header into a delay in milliseconds. Per RFC 9110 the value
 * is either a non-negative number of seconds or an HTTP-date. Returns undefined
 * when the header is absent or unparseable, so the caller falls back to linear
 * backoff.
 */
function parseRetryAfter(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (/^[0-9]+$/.test(trimmed)) return Number(trimmed) * 1000;
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, when - Date.now());
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
    this.retryDelayMs = options.retryDelayMs ?? 200;
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
    const headers: Record<string, string> = {
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
        attempt += 1;
        // Honour a Retry-After header (delta-seconds or HTTP-date) when present,
        // clamped to MAX_RETRY_AFTER_MS; otherwise fall back to linear backoff.
        const retryAfter = parseRetryAfter(headerValue(response.headers["retry-after"]));
        const delay =
          retryAfter !== undefined
            ? Math.min(retryAfter, MAX_RETRY_AFTER_MS)
            : this.retryDelayMs * attempt;
        await this.sleep(delay);
        continue;
      }

      // Follow redirects, resolving the Location relative to the current URL.
      // abgeordnetenwatch 301-redirects a collection path without its trailing
      // slash (`/api/v2` -> `/api/v2/`), so this matters in practice.
      if (status >= 300 && status < 400 && redirects < this.maxRedirects) {
        const location = response.headers["location"];
        if (typeof location === "string" && location.length > 0) {
          const nextUrl = new URL(location, url);
          // Credential-strip guard: if the redirect target is a different origin,
          // drop any sensitive headers so Authorization/cookie-style credentials
          // are never sent to an arbitrary host named in Location.
          if (nextUrl.host !== new URL(url).host) {
            stripSensitiveHeaders(headers);
          }
          url = nextUrl.toString();
          redirects += 1;
          continue;
        }
        // A 3xx with no usable Location is malformed; fall through and let the
        // status be surfaced as an AwApiError rather than looping forever.
      }

      const contentType = String(response.headers["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, response.body);
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
        `Unexpected content type "${res.contentType}" from ${path} (expected JSON).`,
      );
    }
    const text = res.data.toString("utf8");
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new AwParseError(`Failed to parse JSON response from ${path}`, { cause });
    }
  }

  private toApiError(method: string, url: string, status: number, body: Buffer): AwApiError {
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
    return new AwApiError({ status, url, method, body: text, detail });
  }
}
