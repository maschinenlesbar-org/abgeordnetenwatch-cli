// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

/** Base class for every error originating from this client. */
export class AwError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Maximum URL length echoed into a human-readable error message. */
const MAX_URL_IN_MESSAGE = 200;

/** Shorten an overly long URL for display, keeping head and tail context. */
function truncateUrl(url: string): string {
  if (url.length <= MAX_URL_IN_MESSAGE) return url;
  const head = url.slice(0, MAX_URL_IN_MESSAGE - 40);
  const tail = url.slice(-20);
  return `${head}…[${url.length} chars]…${tail}`;
}

/**
 * The API responded with a non-2xx status code. `detail` holds a human-readable
 * message extracted from the response body when one is present — for
 * abgeordnetenwatch that is the `meta.status_message` field.
 */
export class AwApiError extends AwError {
  readonly status: number;
  readonly detail: string | undefined;
  readonly url: string;
  readonly method: string;
  readonly body: string;

  constructor(args: {
    status: number;
    url: string;
    method: string;
    body: string;
    detail?: string;
  }) {
    const detailPart = args.detail ? `: ${args.detail}` : "";
    // Cap the URL in the human-readable message so a pathologically long URL
    // (e.g. a huge filter that triggers an HTTP 414) doesn't dump multiple KB to
    // stderr. The full URL remains available on `this.url` for programmatic use.
    super(`HTTP ${args.status} for ${args.method} ${truncateUrl(args.url)}${detailPart}`);
    this.status = args.status;
    this.url = args.url;
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
  }

  /** True for statuses the API documents as transient and retry-able. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503;
  }
}

/** A transport-level failure (DNS, connection reset, timeout, ...). */
export class AwNetworkError extends AwError {}

/** The response body could not be parsed as the expected JSON shape. */
export class AwParseError extends AwError {}
