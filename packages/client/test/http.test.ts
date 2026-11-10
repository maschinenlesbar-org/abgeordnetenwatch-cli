import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import net from "node:net";
import { AbgeordnetenwatchClient } from "../src/client.js";
import { nodeHttpTransport } from "../src/http.js";
import { AwNetworkError } from "../src/errors.js";

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

test("timeoutMs bounds the whole response, not just idle gaps", async () => {
  // A server that trickles a byte every 50 ms for 2 s never goes idle for the timeout.
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("[");
      const drip = setInterval(() => res.write(" "), 50);
      const finish = setTimeout(() => res.end("]"), 2000);
      res.on("close", () => {
        clearInterval(drip);
        clearTimeout(finish);
      });
    },
    async (baseUrl) => {
      const started = Date.now();
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, timeoutMs: 300 }),
        (err) => err instanceof AwNetworkError && /timed out after 300ms/.test(err.message),
      );
      assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
    },
  );
});

test("a timeoutMs beyond Node's timer range is capped, not fired after 1 ms", async () => {
  const warnings: string[] = [];
  const onWarning = (warning: Error) => void warnings.push(warning.name);
  process.on("warning", onWarning);
  try {
    await withServer(
      (_req, res) => void setTimeout(() => res.end("{}"), 50),
      async (baseUrl) => {
        const resp = await nodeHttpTransport({ method: "GET", url: baseUrl, timeoutMs: 3_000_000_000 });
        assert.equal(resp.body.toString("utf8"), "{}");
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(warnings.filter((name) => name === "TimeoutOverflowWarning"), []);
  } finally {
    process.off("warning", onWarning);
  }
});

test("the default transport rejects a non-http(s) URL with AwNetworkError", async () => {
  await assert.rejects(
    () => nodeHttpTransport({ method: "GET", url: "file:///etc/passwd" }),
    AwNetworkError,
  );
});

test("a header Node cannot send rejects with AwNetworkError, not a raw TypeError", async () => {
  await withServer(
    (_req, res) => res.end(),
    async (baseUrl) => {
      await assert.rejects(
        nodeHttpTransport({
          method: "GET",
          url: `${baseUrl}/x`,
          headers: { "User-Agent": "a\r\nX-Injected: 1" },
          timeoutMs: 1000,
        }),
        (err: unknown) => err instanceof AwNetworkError && /^Invalid request: /.test(err.message),
      );
    },
  );
});

test("maxResponseBytes cuts a body off while it streams, not after it was read", async () => {
  // The engine checks the size of whatever a transport returns, so the error alone can't
  // tell whether the built-in transport stopped early: a server that sends far more than
  // the limit must be cut off long before it finishes, or a huge body is buffered whole.
  const chunk = Buffer.alloc(64 * 1024, 0x20);
  const total = 50 * 1024 * 1024;
  let written = 0;
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      let open = true;
      res.on("close", () => (open = false));
      const pump = () => {
        while (open && written < total) {
          written += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        if (open) res.end();
      };
      pump();
    },
    async (baseUrl) => {
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, timeoutMs: 10_000, maxResponseBytes: 1024 }),
        (err) => err instanceof AwNetworkError && /size limit of 1024 bytes/.test(err.message),
      );
      assert.ok(written < total / 4, `the server wrote ${written} of ${total} bytes before the cut`);
    },
  );
});

/** Serve one raw HTTP answer from a TCP server for one test and return its base URL. */
async function withRawServer(answer: Buffer, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = net.createServer((socket) => {
    socket.once("data", () => socket.end(answer));
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("a body in many tiny chunks arrives whole and in order, and the byte cap still holds (I)", async () => {
  // 300 001 chunks of 1 to 3 bytes: whatever the transport joins on the way, every byte is kept
  // once, in order (the memory side is conformance test P27, the bin in a small heap).
  const pieces = Array.from({ length: 300_001 }, (_, i) => "abc".slice(0, (i % 3) + 1));
  const head = "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n";
  const wire = Buffer.from(head + pieces.map((p) => `${p.length}\r\n${p}\r\n`).join("") + "0\r\n\r\n", "latin1");
  const expected = pieces.join("");
  await withRawServer(wire, async (baseUrl) => {
    const res = await nodeHttpTransport({ method: "GET", url: baseUrl });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, expected.length);
    assert.ok(Buffer.from(res.body).equals(Buffer.from(expected, "latin1")));
  });
  await withRawServer(wire, async (baseUrl) => {
    await assert.rejects(
      () => nodeHttpTransport({ method: "GET", url: baseUrl, maxResponseBytes: expected.length - 1 }),
      (err: unknown) => err instanceof AwNetworkError && /exceeded the size limit/.test(err.message),
    );
  });
  await withRawServer(wire, async (baseUrl) => {
    const res = await nodeHttpTransport({ method: "GET", url: baseUrl, maxResponseBytes: expected.length });
    assert.equal(res.body.length, expected.length);
  });
});

test("a URL typed without its scheme is refused without its user name, token or password (F5 class)", async () => {
  // `my_user:pw@h` doesn't parse ("_" is no scheme character) and was quoted with its password;
  // `T0kenS3cret:@h` parses with the token as its scheme, which the message named, lower-cased.
  for (const url of ["my_user:s3cret-pw@h.example/x", "T0kenS3cret:@h.example/x", "alice:s3cret-pw@h.example/x"]) {
    const err = await nodeHttpTransport({ method: "GET", url, headers: {} }).then(
      () => assert.fail(`${url}: accepted`),
      (caught: unknown) => caught,
    );
    assert.ok(err instanceof AwNetworkError, String(err));
    assert.ok(!/s3cret|t0kens3cret|T0kenS3cret|my_user|alice/.test(err.message), err.message);
    assert.match(err.message, /\*\*\*@h\.example\/x/);
  }
  // A scheme spelled as one (`scheme://`) is still named.
  const ftp = await nodeHttpTransport({ method: "GET", url: "ftp://alice:s3cret-pw@h.example/x", headers: {} }).catch((e: unknown) => e);
  assert.ok(ftp instanceof AwNetworkError && ftp.message === 'Unsupported protocol "ftp:" in URL: ftp://***@h.example/x', String(ftp));
});
