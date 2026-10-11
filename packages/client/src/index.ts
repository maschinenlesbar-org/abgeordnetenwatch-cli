// Public entry point for the API client library.

export { AbgeordnetenwatchClient, LIST_PARAM_KEYS, assertKnownListParams } from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  assertValidBaseUrl,
  cleartextProblem,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  isTransientNetworkError,
  MAX_MESSAGE_TEXT,
  cutForMessage,
} from "./engine.js";
export type { EngineOptions, RawResponse, RetryEvent } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport, sizeLimitMessage } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryValue } from "./query.js";
export {
  AwError,
  AwApiError,
  AwNetworkError,
  AwParseError,
  AwValidationError,
  redactUrl,
  credentialsIn,
  redactCredentials,
} from "./errors.js";
export {
  assertValid,
  entityIdProblem,
  normalizeEntityId,
  nonBlankProblem,
  rangeProblem,
  sortDirectionProblem,
  sortPairProblem,
  validateListParams,
  headerValueProblem,
  headerNameProblem,
  baseUrlProblem,
  describeValue,
  assertParams,
} from "./validate.js";
export type { Problem } from "./validate.js";
export {
  FILTER_KEY,
  RESERVED_FILTER_FIELDS,
  FORBIDDEN_FILTER_FIELDS,
  filterValueProblem,
  filterBlankProblem,
  filterKeyProblem,
  reservedFilterProblem,
  filterOperatorProblem,
  filterClashProblem,
  filterField,
  validateFilters,
} from "./filters.js";

export * from "./types.js";
