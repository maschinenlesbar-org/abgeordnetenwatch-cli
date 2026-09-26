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

import { RequestEngine, type EngineOptions } from "./engine.js";
import type { QueryParams } from "./query.js";
import { AwParseError } from "./errors.js";
import {
  type ListParams,
  type ListResponse,
  type DetailResponse,
  type Entity,
  type EntityCollection,
} from "./types.js";

const API_PREFIX = "/api/v2";

export class AbgeordnetenwatchClient {
  private readonly engine: RequestEngine;

  constructor(options: EngineOptions = {}) {
    this.engine = new RequestEngine(options);
  }

  /**
   * Translate ListParams into the wire query parameters. Filters go in first, so a
   * filter named like a paging or sort parameter (`range_end`) cannot override the
   * typed option, nor the `range_end=1` that `count()` relies on.
   */
  private toQuery(params: ListParams): QueryParams {
    const query: QueryParams = {};
    if (params.filters) {
      for (const [key, value] of Object.entries(params.filters)) query[key] = value;
    }
    if (params.rangeStart !== undefined) query["range_start"] = params.rangeStart;
    if (params.rangeEnd !== undefined) query["range_end"] = params.rangeEnd;
    if (params.sortBy !== undefined) query["sort_by"] = params.sortBy;
    if (params.sortDirection !== undefined) query["sort_direction"] = params.sortDirection;
    return query;
  }

  /**
   * List a collection; returns the full envelope (meta + data array). A 2xx body
   * that is not such an envelope raises AwParseError.
   */
  async list<T = Entity>(
    collection: EntityCollection,
    params: ListParams = {},
  ): Promise<ListResponse<T>> {
    const path = `${API_PREFIX}/${collection}`;
    const body = await this.engine.getJson<unknown>(path, this.toQuery(params));
    assertEnvelope(body, path);
    if (!Array.isArray(body["data"])) throw shapeError(path, "a data array");
    return body as unknown as ListResponse<T>;
  }

  /**
   * Fetch a single entity by id; returns the full envelope (meta + data object). A
   * 2xx body that is not such an envelope raises AwParseError.
   */
  async get<T = Entity>(
    collection: EntityCollection,
    id: number | string,
  ): Promise<DetailResponse<T>> {
    const path = `${API_PREFIX}/${collection}/${encodeURIComponent(String(id))}`;
    const body = await this.engine.getJson<unknown>(path);
    assertEnvelope(body, path);
    if (!isObject(body["data"])) throw shapeError(path, "a data object");
    return body as unknown as DetailResponse<T>;
  }

  /**
   * How many entities match the given filters.
   *
   * Asks for a single item (`range_end: 1`) and reads `meta.result.total`, which
   * the API reports as the true match count independent of the page size.
   */
  async count(collection: EntityCollection, params: ListParams = {}): Promise<number> {
    const res = await this.list(collection, { ...params, rangeEnd: 1 });
    const total: unknown = (res.meta.result as unknown as { total?: unknown } | undefined)?.total;
    if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
      throw shapeError(`${API_PREFIX}/${collection}`, "a numeric meta.result.total");
    }
    return total;
  }
}

/** True for a JSON object (not null, not an array). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shapeError(path: string, expected: string): AwParseError {
  return new AwParseError(`Unexpected response shape from ${path}: expected ${expected}.`);
}

/**
 * Check the `{ meta, data }` envelope every 2xx response carries. A body of `null`,
 * an array or an object without `meta` would otherwise surface as a raw TypeError
 * ("Cannot read properties of null") or print as if it were data.
 */
function assertEnvelope(body: unknown, path: string): asserts body is Record<string, unknown> {
  if (!isObject(body) || !isObject(body["meta"])) {
    throw shapeError(path, "a JSON object with meta and data");
  }
}
