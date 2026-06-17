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

  /** Translate ListParams into the wire query parameters. */
  private toQuery(params: ListParams): QueryParams {
    const query: QueryParams = {};
    if (params.rangeStart !== undefined) query["range_start"] = params.rangeStart;
    if (params.rangeEnd !== undefined) query["range_end"] = params.rangeEnd;
    if (params.sortBy !== undefined) query["sort_by"] = params.sortBy;
    if (params.sortDirection !== undefined) query["sort_direction"] = params.sortDirection;
    if (params.filters) {
      for (const [key, value] of Object.entries(params.filters)) query[key] = value;
    }
    return query;
  }

  /** List a collection; returns the full envelope (meta + data array). */
  list<T = Entity>(
    collection: EntityCollection,
    params: ListParams = {},
  ): Promise<ListResponse<T>> {
    return this.engine.getJson(`${API_PREFIX}/${collection}`, this.toQuery(params));
  }

  /** Fetch a single entity by id; returns the full envelope (meta + data object). */
  get<T = Entity>(
    collection: EntityCollection,
    id: number | string,
  ): Promise<DetailResponse<T>> {
    return this.engine.getJson(`${API_PREFIX}/${collection}/${encodeURIComponent(String(id))}`);
  }

  /**
   * How many entities match the given filters.
   *
   * Asks for a single item (`range_end: 1`) and reads `meta.result.total`, which
   * the API reports as the true match count independent of the page size.
   */
  async count(collection: EntityCollection, params: ListParams = {}): Promise<number> {
    const res = await this.list(collection, { ...params, rangeEnd: 1 });
    return res.meta.result.total;
  }
}
