// Test helpers: a mock upstream (by collection path), a config, and an in-process MCP
// connection over the SDK's InMemoryTransport with raw JSON-RPC, so the tests see exactly what a
// client receives. Nothing reaches the network.

import { jsonResponse, makeMockTransport, type MockTransport } from "@maschinenlesbar.org/abgeordnetenwatch-client/test/helpers";
import { createLogger, type Logger } from "@maschinenlesbar.org/abgeordnetenwatch-log";
import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { parseConfig, type McpConfig } from "../src/mcp/config.js";
import { createServerFactory } from "../src/mcp/server.js";

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

/** The default config with `overrides`. */
export function config(overrides: Partial<McpConfig> = {}): McpConfig {
  const parsed = parseConfig([]);
  if (parsed.kind !== "run") throw new Error("defaults don't parse");
  return { ...parsed.config, ...overrides };
}

/** A logger whose records land in `lines`. */
export function recorder(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return { lines, log: createLogger({ program: "abgeordnetenwatch-mcp", format: "text", write: (line) => lines.push(line), now: () => new Date(0) }) };
}

export interface Connection {
  /** Send a request; resolves with the whole JSON-RPC response. */
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** The result of tools/call, or throws on a JSON-RPC error. */
  call(name: string, args: Record<string, unknown>): Promise<{ content: { type: string; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }>;
  initialize: Record<string, unknown>;
  close(): Promise<void>;
}

/** Connect to a server from the factory over InMemoryTransport, after the 2025-11-25 handshake. */
export async function connect(options: { transport: MockTransport; config?: Partial<McpConfig>; log?: Logger }): Promise<Connection> {
  const factory = createServerFactory({ config: config(options.config), transport: options.transport.transport, log: options.log ?? recorder().log });
  const [client, server] = InMemoryTransport.createLinkedPair();
  await factory().connect(server);
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  client.onmessage = (message: JSONRPCMessage) => {
    const { id } = message as { id?: number };
    if (id !== undefined) pending.get(id)?.(message as Record<string, unknown>);
  };
  await client.start();
  let next = 1;
  const request = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = next++;
    const answer = new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve));
    void client.send({ jsonrpc: "2.0", id, method, params } as JSONRPCMessage);
    return answer;
  };
  const initialize = await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
  return {
    request,
    initialize,
    async call(name, args) {
      const answer = await request("tools/call", { name, arguments: args });
      if (answer["error"] !== undefined) throw Object.assign(new Error(JSON.stringify(answer["error"])), { rpc: answer["error"] });
      return answer["result"] as Awaited<ReturnType<Connection["call"]>>;
    },
    close: () => client.close(),
  };
}

export const politician = (id: number, label: string): Item => ({ id, label, party: { id: 1, label: "SPD" }, year_of_birth: 1958 });
export const mandate = (id: number, period: string): Item => ({ id, type: "mandate", label: `${period} mandate`, parliament_period: { id: 161, label: period } });
export const vote = (id: number, pollId: number, value: string, fraction = "SPD"): Item => ({ id, vote: value, poll: { id: pollId, label: `Poll ${pollId}` }, fraction: { id: 3, label: fraction } });
