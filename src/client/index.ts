// Public entry point for the API client library.

export { AbgeordnetenwatchClient } from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  assertValidBaseUrl,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
} from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
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
} from "./validate.js";
export type { Problem } from "./validate.js";
export {
  FILTER_KEY,
  RESERVED_FILTER_FIELDS,
  filterBlankProblem,
  filterKeyProblem,
  reservedFilterProblem,
  filterOperatorProblem,
  filterClashProblem,
  filterField,
  validateFilters,
} from "./filters.js";

export * from "./types.js";
