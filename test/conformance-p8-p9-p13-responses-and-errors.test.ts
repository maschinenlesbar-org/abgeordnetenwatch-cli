// Conformance test P8 + P9 + P13 (fix plan 2026-10-06): a body is decoded by its declared
// charset (P8); a 2xx body without the documented shape is a parse error, never data or
// "nothing found" (P9); every rejected input is the library's validation error, never a raw
// TypeError or RangeError (P13). Shared across the *-cli repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { AbgeordnetenwatchClient as Client } from "../src/client/client.js";
import {
  AwError as BaseError,
  AwParseError as ParseError,
  AwValidationError as ValidationError,
} from "../src/client/errors.js";
import type { EntityCollection, ListParams } from "../src/client/types.js";
/** A call whose answer contains a text field, and how to read that field from the result. */
const textCall = (client: Client): Promise<unknown> => client.get("parties", 1);
const textBody = (text: string): unknown => ({ meta: { status: "ok" }, data: { id: 1, label: text } });
const readText = (result: unknown): string => (result as { data: { label: string } }).data.label;
/** 2xx bodies the call must reject (error envelopes, empty or wrong shapes). */
const malformedBodies: unknown[] = [null, {}, [], "text", 42, { meta: null, data: {} }, { error: "boom" }, { meta: {}, data: [] }, { meta: {} }];
/** Library calls with wrong-typed or out-of-range input. */
const badCalls: Array<[string, () => unknown]> = [
  ['list("toString")', () => new Client().list("toString" as EntityCollection)],
  ["list(5)", () => new Client().list(5 as unknown as EntityCollection)],
  ['list("parties", null)', () => new Client().list("parties", null as unknown as ListParams)],
  ['count("parties", 5)', () => new Client().count("parties", 5 as unknown as ListParams)],
  ['list("parties", { filters: 5 })', () => new Client().list("parties", { filters: 5 as unknown as ListParams["filters"] })],
  ['list("parties", { filters: "sex=f" })', () => new Client().list("parties", { filters: "sex=f" as unknown as ListParams["filters"] })],
  ['list("parties", { rangeEnd: "5" })', () => new Client().list("parties", { rangeEnd: "5" as unknown as number })],
  ['get("parties", null)', () => new Client().get("parties", null as unknown as number)],
  ['get("parties", {})', () => new Client().get("parties", {} as unknown as number)],
  ["timeoutMs: 'x'", () => new Client({ timeoutMs: "x" as unknown as number })],
  ["timeoutMs: -1", () => new Client({ timeoutMs: -1 })],
  ["maxRetries: 1.5", () => new Client({ maxRetries: 1.5 })],
  ["baseUrl: 5", () => new Client({ baseUrl: 5 as unknown as string })],
  ["userAgent: {}", () => new Client({ userAgent: {} as unknown as string })],
  ["headers: 'abc'", () => new Client({ headers: "abc" as unknown as Record<string, string> })],
  ["options: null", () => new Client(null as unknown as {})],
  ["transport: 5", () => new Client({ transport: 5 as unknown as never })],
];
// --------------------------------------------------------------------------------------

const respond = (body: Buffer, contentType: string) => async (): Promise<HttpResponse> => ({
  status: 200,
  headers: { "content-type": contentType },
  body,
});

test("P8: a body is decoded by its declared charset", async () => {
  const text = "Müller µg/l";
  for (const [charset, encoding] of [["iso-8859-1", "latin1"], ["utf-8", "utf8"]] as const) {
    const body = Buffer.from(JSON.stringify(textBody(text)), encoding);
    const client = new Client({ transport: respond(body, `application/json; charset=${charset}`) });
    assert.equal(readText(await textCall(client)), text, charset);
  }
});

test("P9: a 2xx body without the documented shape is a parse error", async () => {
  for (const body of malformedBodies) {
    const client = new Client({ transport: respond(Buffer.from(JSON.stringify(body)), "application/json"), maxRetries: 0 });
    await assert.rejects(textCall(client), ParseError, `body ${JSON.stringify(body)}`);
  }
  for (const raw of ["", "<html>maintenance</html>"]) {
    const client = new Client({ transport: respond(Buffer.from(raw), "text/html"), maxRetries: 0 });
    await assert.rejects(textCall(client), BaseError, `raw ${JSON.stringify(raw)}`);
  }
});

test("P13: every rejected input is the validation error, never a raw TypeError", async () => {
  for (const [label, fn] of badCalls) {
    await assert.rejects(async () => fn(), (e: unknown) => e instanceof ValidationError, label);
  }
});
