import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { AbgeordnetenwatchClient } from "../src/client/client.js";
import { nodeHttpTransport } from "../src/client/http.js";
import { AwNetworkError } from "../src/client/errors.js";

/** Start a throwaway local HTTP server bound to an ephemeral port. */
async function withServer(
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  server.listen(0);
  await once(server, "listening");
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("real transport fetches and parses a collection over HTTP", async () => {
  await withServer(
    (req, res) => {
      assert.match(req.url ?? "", /^\/api\/v2\/parties/);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ meta: { result: { total: 1 } }, data: [{ id: 1, label: "CDU" }] }));
    },
    async (baseUrl) => {
      const client = new AbgeordnetenwatchClient({ baseUrl });
      const out = await client.list("parties");
      assert.equal(out.data.length, 1);
    },
  );
});

test("real transport follows a 301 redirect (trailing-slash style)", async () => {
  await withServer(
    (req, res) => {
      if (req.url === "/api/v2/topics") {
        res.writeHead(301, { location: "/api/v2/topics/" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ meta: { result: { total: 0 } }, data: [] }));
    },
    async (baseUrl) => {
      const client = new AbgeordnetenwatchClient({ baseUrl });
      const out = await client.list("topics");
      assert.deepEqual(out.data, []);
    },
  );
});

test("the default transport rejects a non-http(s) URL with AwNetworkError", async () => {
  await assert.rejects(
    () => nodeHttpTransport({ method: "GET", url: "file:///etc/passwd" }),
    AwNetworkError,
  );
});
