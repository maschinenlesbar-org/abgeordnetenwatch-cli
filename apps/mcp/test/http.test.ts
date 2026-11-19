// The HTTP transport as a client and an attacker see it: one endpoint, the 2025 handshake served
// statelessly, DNS-rebinding protection (Host and Origin), the body cap, and the log records.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { run } from "../src/mcp/run.js";
import { upstream } from "./helpers.js";

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A raw request: node:http, so the test can set Host (fetch can't). */
function send(port: number, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: options.method ?? "POST", path: options.path ?? "/mcp", headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
const headers = (port: number, extra: Record<string, string> = {}) => ({ "content-type": "application/json", accept: "application/json, text/event-stream", host: `127.0.0.1:${port}`, ...extra });

/** Run the server on a free port; `use` gets the port; the records are returned. */
async function withServer(argv: string[], use: (port: number) => Promise<void>, inContainer = false): Promise<string[]> {
  const lines: string[] = [];
  let stop: () => void = () => {};
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  let listening: (port: number) => void = () => {};
  const port = new Promise<number>((resolve) => (listening = resolve));
  const done = run(["--transport", "http", "--port", "0", ...argv], {
    stdout: () => {},
    stderr: (line) => lines.push(line),
    transport: upstream(() => []).transport,
    stopped,
    onListening: (server) => listening((server.address() as AddressInfo).port),
    inContainer: () => inContainer,
  });
  try {
    // A server that ends before it listens (a usage error) fails the test instead of hanging it.
    const listeningPort = await Promise.race([port, done.then((code) => Promise.reject(new Error(`the server ended with ${code} before listening: ${lines.join(" | ")}`)))]);
    await use(listeningPort);
  } finally {
    stop();
    assert.equal(await done, 0);
  }
  return lines;
}

test("POST /mcp serves a 2025-06-18 handshake statelessly; GET is 405; /healthz is 200; anything else 404", async () => {
  const lines = await withServer([], async (port) => {
    const answer = await send(port, { headers: headers(port), body: initialize });
    assert.equal(answer.status, 200, answer.body);
    assert.match(answer.body, /"protocolVersion":"2025-06-18"/);
    assert.equal((await send(port, { method: "GET", headers: headers(port) })).status, 405);
    assert.equal((await send(port, { method: "GET", path: "/healthz", headers: headers(port) })).status, 200);
    assert.equal((await send(port, { path: "/other", headers: headers(port), body: initialize })).status, 404);
  });
  assert.ok(lines.every((line) => /^\S+Z (INFO|WARN|ERROR) +\[abgeordnetenwatch-mcp\.\w+\] /.test(line)), lines.join("\n"));
  assert.match(lines.join("\n"), /INFO  \[abgeordnetenwatch-mcp\.mcp\] abgeordnetenwatch-mcp \S+ serving MCP on http:\/\/127\.0\.0\.1:\d+\/mcp/);
});

test("a foreign Host is refused (DNS rebinding), an allowed one served", async () => {
  await withServer(["--allowed-hosts", "localhost,127.0.0.1,mcp.example.org"], async (port) => {
    assert.equal((await send(port, { headers: headers(port, { host: `evil.example:${port}` }), body: initialize })).status, 403);
    assert.equal((await send(port, { headers: headers(port, { host: "mcp.example.org" }), body: initialize })).status, 200);
  });
});

test("a browser Origin must be one of --allowed-origins exactly (scheme, host and port); none is allowed by default", async () => {
  await withServer(["--allowed-origins", "https://app.example.org,http://localhost:6274"], async (port) => {
    const status = async (origin: string) => (await send(port, { headers: headers(port, { origin }), body: initialize })).status;
    assert.equal(await status("https://app.example.org"), 200);
    assert.equal(await status("http://localhost:6274"), 200);
    assert.equal(await status("http://evil.example"), 403);
    assert.equal(await status("null"), 403);
    assert.equal(await status("http://localhost:9999"), 403, "another port is another origin");
    assert.equal(await status(`http://localhost:${port}`), 403, "the server serves no pages: its own origin isn't allowed either");
    assert.equal(await status("http://app.example.org"), 403, "another scheme");
    assert.equal(await status("https://app.example.org:8443"), 403);
    assert.equal(await status("https://app.example.org.evil.example"), 403);
  });
  await withServer([], async (port) => {
    assert.equal((await send(port, { headers: headers(port, { origin: "http://localhost:9999" }), body: initialize })).status, 403);
    assert.equal((await send(port, { headers: headers(port), body: initialize })).status, 200, "no Origin (not a browser) passes");
  });
});

test("a body over 1 MiB is 413", async () => {
  await withServer([], async (port) => {
    // Only the headers: the server answers from the declared length before reading a byte. (Sending
    // the whole body raced with the server's close and sometimes ended in a reset, not the answer.)
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () =>
        socket.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: ${1024 * 1024 + 1}\r\n\r\n`),
      );
      let data = "";
      socket.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
      socket.on("close", () => resolve(data));
      socket.on("error", reject);
    });
    assert.match(answer, /^HTTP\/1\.1 413 /);
  });
});

test("a non-loopback address is a WARN record: the server has no authentication", async () => {
  const lines = await withServer(["--host", "0.0.0.0", "--allowed-hosts", "localhost,127.0.0.1"], async () => {});
  assert.match(
    lines.join("\n"),
    /WARN  \[abgeordnetenwatch-mcp\.http\] listening on 0\.0\.0\.0: reachable from outside this container or machine, and the server has no authentication\. Publish the port on 127\.0\.0\.1 only \(docker run -p 127\.0\.0\.1:<host port>:\d+\) or put an authenticating proxy in front\./,
  );
});

test("a usage error is one ERROR record and exit 2; a port in use is exit 1", async () => {
  const lines: string[] = [];
  const code = await run(["--port", "x"], { stdout: () => {}, stderr: (line) => lines.push(line), stopped: Promise.resolve() });
  assert.equal(code, 2);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /ERROR \[abgeordnetenwatch-mcp\.mcp\] --port must be a whole number/);
  await withServer([], async (port) => {
    const busy: string[] = [];
    const again = await run(["--transport", "http", "--port", String(port)], { stdout: () => {}, stderr: (line) => busy.push(line), stopped: Promise.resolve() });
    assert.equal(again, 1);
    assert.match(busy.join("\n"), /ERROR \[abgeordnetenwatch-mcp\.http\] Could not listen/);
  });
});

test("loopback inside a container is a WARN: a published port can't reach it, --host 0.0.0.0 can", async () => {
  const inside = await withServer([], async () => {}, true);
  assert.match(inside.join("\n"), /WARN  \[abgeordnetenwatch-mcp\.http\] listening on 127\.0\.0\.1 inside a container: a published port \(docker run -p\) can't reach it\. Add --host 0\.0\.0\.0 to serve through the published port\./);
  const outside = await withServer([], async () => {}, false);
  assert.doesNotMatch(outside.join("\n"), /inside a container/);
  const opened = await withServer(["--host", "0.0.0.0"], async () => {}, true);
  assert.doesNotMatch(opened.join("\n"), /inside a container/);
});
