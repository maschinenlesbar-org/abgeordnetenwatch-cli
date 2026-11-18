// The built MCP server against the official MCP client, the way clients connect: over stdio
// (the bin as a child process) and over Streamable HTTP, each in the client's three modes:
// legacy (the 2025-11-25 handshake), auto (probes server/discover, 2026-07-28) and pinned
// 2026-07-28. Every tool is listed and three are called against a mock upstream on loopback.
// Exits 1 on the first failure.
//
//   npm ci --ignore-scripts --prefix tools/interop && node tools/interop/interop.mjs

import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const bin = fileURLToPath(new URL("../../apps/mcp/dist/src/mcp/index.js", import.meta.url));

const data = {
  politicians: [{ id: 7, label: "Olaf Scholz", party: { id: 1, label: "SPD" }, year_of_birth: 1958 }],
  "candidacies-mandates": [{ id: 70, type: "mandate", label: "Bundestag 2025 - 2029", parliament_period: { id: 161, label: "Bundestag 2025 - 2029" } }],
  votes: [{ id: 1, vote: "yes", poll: { id: 9, label: "Haushalt" }, fraction: { id: 3, label: "SPD" } }, { id: 2, vote: "no_show", poll: { id: 8, label: "Rente" }, fraction: { id: 3, label: "SPD" } }],
  parties: [{ id: 1, label: "SPD" }],
};
const upstream = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const items = data[url.pathname.split("/")[3]] ?? [];
  const page = items.slice(0, Number(url.searchParams.get("range_end") ?? 100));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ meta: { status: "ok", status_message: "", result: { count: page.length, total: items.length, range_start: 0, range_end: page.length } }, data: page }));
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${upstream.address().port}`;

const httpServer = spawn(process.execPath, [bin, "--transport", "http", "--port", "0", "--base-url", baseUrl], { stdio: ["ignore", "ignore", "pipe"] });
const endpoint = await new Promise((resolve, reject) => {
  let log = "";
  httpServer.stderr.on("data", (chunk) => {
    log += chunk;
    const found = /serving MCP on (http:\/\/\S+)/.exec(log);
    if (found) resolve(found[1]);
  });
  httpServer.once("exit", (code) => reject(new Error(`the HTTP server exited with ${code}: ${log}`)));
});

let failed = false;
const modes = [["legacy", "legacy", "2025-11-25"], ["auto", "auto", "2026-07-28"], ["pinned", { pin: "2026-07-28" }, "2026-07-28"]];
try {
  for (const kind of ["stdio", "http"]) {
    for (const [label, mode, expected] of modes) {
      const client = new Client({ name: "interop", version: "0" }, { versionNegotiation: { mode } });
      const transport =
        kind === "stdio"
          ? new StdioClientTransport({ command: process.execPath, args: [bin, "--base-url", baseUrl], stderr: "ignore" })
          : new StreamableHTTPClientTransport(new URL(endpoint));
      try {
        await client.connect(transport);
        const version = client.getNegotiatedProtocolVersion();
        if (version !== expected) throw new Error(`negotiated ${version}, expected ${expected}`);
        const tools = (await client.listTools()).tools;
        if (tools.length !== 8) throw new Error(`${tools.length} tools`);
        const record = await client.callTool({ name: "getVotingRecord", arguments: { name: "Scholz" } });
        if (record.isError || record.structuredContent?.tally?.no_show !== 1) throw new Error(`getVotingRecord: ${JSON.stringify(record).slice(0, 300)}`);
        const listed = await client.callTool({ name: "listEntities", arguments: { collection: "parties" } });
        if (listed.isError || listed.structuredContent?.total !== 1) throw new Error(`listEntities: ${JSON.stringify(listed).slice(0, 300)}`);
        const bad = await client.callTool({ name: "findPolitician", arguments: { name: "x", limit: 500 } });
        if (bad.isError !== true) throw new Error("bad arguments were not a tool error");
        console.log(`ok ${kind} ${label} (${version})`);
      } catch (err) {
        failed = true;
        console.log(`FAILED ${kind} ${label}: ${err.message}`);
        if (process.env.GITHUB_ACTIONS === "true") console.log(`::error::interop ${kind} ${label}: ${err.message}`);
      } finally {
        await client.close().catch(() => {});
      }
    }
  }
} finally {
  httpServer.kill("SIGTERM");
  upstream.close();
}
process.exit(failed ? 1 : 0);
