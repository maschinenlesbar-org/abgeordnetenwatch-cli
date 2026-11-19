// Test helpers of this server's own tests and the adapters of the conformance tests: a mock
// upstream (by collection path), paged like the API, and fixtures. The generic harness (a
// connection, a config, a log recorder, the HTTP server) is the kit's harness.ts. Nothing reaches
// the network.

import { jsonResponse, makeMockTransport, type MockTransport } from "@maschinenlesbar.org/abgeordnetenwatch-client/test/helpers";

export type Item = Record<string, unknown>;

/** A transport that answers `/api/v2/<collection>[/<id>]` from `route`, paged like the API. */
export function upstream(route: (collection: string, url: URL) => Item[] | Item | undefined): MockTransport {
  return makeMockTransport((request) => {
    const url = new URL(request.url);
    const [, , , collection, id] = url.pathname.split("/");
    const found = route(id === undefined ? (collection ?? "") : `${collection}/${id}`, url);
    if (found === undefined) return jsonResponse({ error: "not found" }, 404);
    if (!Array.isArray(found)) return jsonResponse({ meta: { status: "ok", status_message: "", result: { entity_id: String(found["id"]), entity_type: "x" } }, data: found });
    const start = Number(url.searchParams.get("range_start") ?? 0);
    const data = found.slice(start, start + Number(url.searchParams.get("range_end") ?? 100));
    return jsonResponse({ meta: { status: "ok", status_message: "", result: { count: data.length, total: found.length, range_start: start, range_end: start + data.length } }, data });
  });
}

// The kit's harness (a config, a log recorder, an in-process connection), for this repo's tests.
export { config, connect, recorder, type Connection } from "./harness.js";

export const politician = (id: number, label: string): Item => ({ id, label, party: { id: 1, label: "SPD" }, year_of_birth: 1958 });
export const mandate = (id: number, period: string): Item => ({ id, type: "mandate", label: `${period} mandate`, parliament_period: { id: 161, label: period } });
export const vote = (id: number, pollId: number, value: string, fraction = "SPD"): Item => ({ id, vote: value, poll: { id: pollId, label: `Poll ${pollId}` }, fraction: { id: 3, label: fraction } });
