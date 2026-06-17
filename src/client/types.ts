// Domain types for the abgeordnetenwatch.de API v2.
//
// Every entity is a large, schema-versioned object, so individual `data`
// records are exposed as faithful raw `JsonObject`s while the response envelope
// (`meta` + `data`) is typed at the top level. See openapi.yaml in the repo root
// for the full per-entity field reference.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** One entity record (a politician, mandate, vote, ...). */
export type Entity = JsonObject;

/** The `abgeordnetenwatch_api` metadata block, identical on every response. */
export interface ApiInfo {
  version: string;
  changelog: string;
  licence: string;
  licence_link: string;
  documentation: string;
}

/** `meta.result` for a collection response. */
export interface ListResult {
  count: number;
  total: number;
  range_start: number;
  range_end: number;
}

/** `meta.result` for a single-entity response. */
export interface DetailResult {
  entity_id: string;
  entity_type: string;
}

export interface ListMeta {
  abgeordnetenwatch_api: ApiInfo;
  status: "ok" | "error";
  status_message: string;
  result: ListResult;
}

export interface DetailMeta {
  abgeordnetenwatch_api: ApiInfo;
  status: "ok" | "error";
  status_message: string;
  result: DetailResult;
}

/** Response of a collection endpoint, e.g. `GET /api/v2/politicians`. */
export interface ListResponse<T = Entity> {
  meta: ListMeta;
  data: T[];
}

/** Response of a single-entity endpoint, e.g. `GET /api/v2/politicians/{id}`. */
export interface DetailResponse<T = Entity> {
  meta: DetailMeta;
  data: T;
}

/** Comparison operators usable in a bracket filter `field[op]=value`. */
export type FilterOperator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "cn" | "sw";

/** Parameters for a collection request. */
export interface ListParams {
  /** 0-based offset of the first item to return. */
  rangeStart?: number;
  /** Page size — number of items to return. Capped at 100 by the API. */
  rangeEnd?: number;
  /** Field name to sort by (e.g. `last_name`, `id`). */
  sortBy?: string;
  /** Sort order. */
  sortDirection?: "asc" | "desc";
  /**
   * Arbitrary field filters, merged verbatim into the query string. Keys may use
   * the bracket-operator form, e.g. `{ "year_of_birth[gt]": 1990, sex: "f" }`.
   * Pass a related entity's id directly, e.g. `{ politician: 184945 }`.
   */
  filters?: Record<string, string | number | boolean>;
}

/**
 * The known v2 entity collection path segments. The first element of a pair is
 * the path used in the URL; this is the authoritative list the CLI validates
 * against. Confirmed live against the API on 2026-06-16.
 */
export const ENTITY_COLLECTIONS = [
  "parliaments",
  "parliament-periods",
  "politicians",
  "candidacies-mandates",
  "committees",
  "committee-memberships",
  "polls",
  "votes",
  "parties",
  "fractions",
  "election-program",
  "electoral-lists",
  "constituencies",
  "sidejobs",
  "sidejob-organizations",
  "topics",
  "cities",
  "countries",
] as const;

export type EntityCollection = (typeof ENTITY_COLLECTIONS)[number];

/** Type guard: is `name` one of the known entity collections? */
export function isEntityCollection(name: string): name is EntityCollection {
  return (ENTITY_COLLECTIONS as readonly string[]).includes(name);
}
