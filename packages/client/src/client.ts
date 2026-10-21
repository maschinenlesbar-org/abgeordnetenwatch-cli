// AbgeordnetenwatchClient — a typed client over the open (no-auth) v2 API of
// abgeordnetenwatch.de, Germany's parliamentary-monitoring platform.
//
//   client.list("politicians", { filters: { sex: "f" }, rangeEnd: 10 })
//   client.get("politicians", 184945)
//   client.count("votes", { filters: { poll: 6569 } })
//
// The API is uniform across all entity types — one envelope, list + detail —
// so the client is generic over the collection name rather than exposing 18
// near-identical method pairs. See openapi.yaml for the full entity reference.

import { RequestEngine, sanitizeServerText, type EngineOptions } from "./engine.js";
import type { QueryParams } from "./query.js";
import { AwParseError, AwValidationError, cutForMessage, MAX_QUOTED_LENGTH } from "./errors.js";
import { assertParams, describeValue, normalizeEntityId, validateListParams } from "./validate.js";
import { validateFilters } from "./filters.js";
import {
  ENTITY_COLLECTIONS,
  isEntityCollection,
  type ListParams,
  type ListResponse,
  type DetailResponse,
  type Entity,
  type EntityCollection,
} from "./types.js";

const API_PREFIX = "/api/v2";

/**
 * The keys a ListParams object may have. Any other key (`filter`, `range_end`, `sortby`,
 * `__proto__` from parsed JSON) used to be ignored, so a misspelled `filters` returned the
 * whole collection with no error.
 */
export const LIST_PARAM_KEYS = ["filters", "rangeStart", "rangeEnd", "sortBy", "sortDirection"] as const;

/** Throw AwValidationError for a ListParams key outside {@link LIST_PARAM_KEYS}. */
export function assertKnownListParams(params: object): void {
  for (const key of Object.keys(params)) {
    if (!(LIST_PARAM_KEYS as readonly string[]).includes(key)) {
      throw new AwValidationError(
        `Invalid params: unknown parameter ${describeValue(key)}. Valid parameters: ${LIST_PARAM_KEYS.join(", ")}; filters go in "filters".`,
      );
    }
  }
}

export class AbgeordnetenwatchClient {
  private readonly engine: RequestEngine;

  constructor(options: EngineOptions = {}) {
    this.engine = new RequestEngine(options);
  }

  /**
   * Translate ListParams into the wire query parameters, after checking them
   * (validateListParams, validateFilters). Filters go in first, so even a filter named like a
   * paging or sort parameter could not override the typed option, nor the
   * `range_end=1` that `count()` relies on.
   */
  private toQuery(params: ListParams): QueryParams {
    assertParams("params", params);
    assertKnownListParams(params);
    validateListParams(params);
    // No prototype: a key such as `__proto__` can only ever be a key here.
    const query: QueryParams = Object.create(null) as QueryParams;
    if (params.filters !== undefined && params.filters !== null) {
      validateFilters(params.filters);
      // The API matches composed text only: a decomposed "Müller" (u + U+0308, as pasted
      // from a macOS file name) matched nothing. Nor does it trim: "Scholz " (a trailing
      // space from a spreadsheet or a shell variable) matched nothing either. Send every
      // text value as NFC, without surrounding whitespace.
      for (const [key, value] of Object.entries(params.filters)) {
        query[key] = typeof value === "string" ? value.trim().normalize("NFC") : value;
      }
    }
    if (params.rangeStart !== undefined) query["range_start"] = params.rangeStart;
    if (params.rangeEnd !== undefined) query["range_end"] = params.rangeEnd;
    if (params.sortBy !== undefined) query["sort_by"] = params.sortBy;
    if (params.sortDirection !== undefined) query["sort_direction"] = params.sortDirection;
    return query;
  }

  /** `GET <url>` for an error about the answer to that request (userinfo redacted, cut). */
  private describe(path: string, query?: QueryParams): string {
    return `GET ${this.engine.describeUrl(path, query)}`;
  }

  /**
   * List a collection; returns the full envelope (meta + data array). A 2xx body
   * that is not such an envelope, or whose `meta.status` is not `ok`, raises AwParseError.
   */
  async list<T = Entity>(
    collection: EntityCollection,
    params: ListParams = {},
  ): Promise<ListResponse<T>> {
    const path = `${API_PREFIX}/${checkCollection(collection)}`;
    const query = this.toQuery(params);
    const body = await this.engine.getJson<unknown>(path, query);
    const request = this.describe(path, query);
    assertEnvelope(body, request);
    if (!Array.isArray(body["data"])) throw shapeError(request, "a data array");
    return body as unknown as ListResponse<T>;
  }

  /**
   * Fetch a single entity by id; returns the full envelope (meta + data object). A
   * 2xx body that is not such an envelope (or says `meta.status` other than `ok`) raises AwParseError.
   *
   * The id must be a positive integer, as a number or a string of digits; leading
   * zeros are dropped (`"0002"` fetches entity 2). Anything else (`0`, `""`, `" 2 "`,
   * `"abc"`, `-1`, `1.5`) rejects with AwValidationError before any request.
   */
  async get<T = Entity>(
    collection: EntityCollection,
    id: number | string,
  ): Promise<DetailResponse<T>> {
    const path = `${API_PREFIX}/${checkCollection(collection)}/${normalizeEntityId(id)}`;
    const body = await this.engine.getJson<unknown>(path);
    const request = this.describe(path);
    assertEnvelope(body, request);
    if (!isObject(body["data"])) throw shapeError(request, "a data object");
    return body as unknown as DetailResponse<T>;
  }

  /**
   * How many entities match the given filters.
   *
   * Asks for a single item (`range_end: 1`) and reads `meta.result.total`, which
   * the API reports as the true match count independent of the page size.
   */
  async count(collection: EntityCollection, params: ListParams = {}): Promise<number> {
    // Check the caller's own parameters, including a rangeEnd that is then replaced.
    assertParams("params", params);
    assertKnownListParams(params);
    validateListParams(params);
    const asked: ListParams = { ...params, rangeEnd: 1 };
    const res = await this.list(collection, asked);
    const total: unknown = (res.meta.result as unknown as { total?: unknown } | undefined)?.total;
    if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
      throw shapeError(this.describe(`${API_PREFIX}/${collection}`, this.toQuery(asked)), "a numeric meta.result.total");
    }
    return total;
  }
}

/**
 * The collection is interpolated into the path, so check it at run time as well:
 * a JavaScript caller (or a cast) could otherwise pass `../../x` or `parties?x=1`
 * and walk out of `/api/v2` or inject a query. An unknown one is rejected before any
 * request, so it is an AwValidationError like every other rejected input.
 */
function checkCollection(collection: string): string {
  if (!isEntityCollection(collection)) {
    throw new AwValidationError(
      `Unknown collection ${describeValue(String(collection))}. Valid collections: ${ENTITY_COLLECTIONS.join(", ")}.`,
    );
  }
  return collection;
}

/** True for a JSON object (not null, not an array). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A 2xx answer of the wrong shape; `request` is `GET <url>` (D9: an answer error names the request). */
function shapeError(request: string, expected: string): AwParseError {
  return new AwParseError(`${request}: unexpected response shape: expected ${expected}.`);
}

/**
 * Check the `{ meta, data }` envelope every 2xx response carries. A body of `null`,
 * an array or an object without `meta` would otherwise surface as a raw TypeError
 * ("Cannot read properties of null") or print as if it were data.
 */
function assertEnvelope(body: unknown, request: string): asserts body is Record<string, unknown> {
  if (!isObject(body) || !isObject(body["meta"])) {
    throw shapeError(request, "a JSON object with meta and data");
  }
  // An envelope that says it failed is no answer, whatever the HTTP status: printed as data,
  // its empty `data` read as "none found" (count 0, exit 0). The API sends `ok` on success.
  const status = body["meta"]["status"];
  if (status !== undefined && status !== "ok") {
    const message = body["meta"]["status_message"];
    const reason =
      typeof message === "string" && message.trim() !== ""
        ? cutForMessage(sanitizeServerText(message))
        : `meta.status ${cutForMessage(sanitizeServerText(JSON.stringify(status)), MAX_QUOTED_LENGTH)}`;
    throw new AwParseError(`${request}: error envelope in a 2xx answer: ${reason}`);
  }
}
