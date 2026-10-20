import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AbgeordnetenwatchClient } from "../src/client.js";
import { makeMockTransport, jsonResponse } from "./helpers.js";

// Runs the TypeScript compiler over a consumer file.
const STARTS_A_PROCESS = { timeout: 30_000 };

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("every option field takes undefined under exactOptionalPropertyTypes (bug 2, 2026-10-20)", STARTS_A_PROCESS, async () => {
  // `{ baseUrl: process.env.AW_BASE_URL }` as EngineOptions and `{ sortBy }` with an optional
  // sortBy as ListParams failed with TS2375 in a consumer that sets exactOptionalPropertyTypes:
  // the fields were `?: T`, although the runtime treats undefined as omitted.
  const dir = mkdtempSync(join(tmpdir(), "aw-types-"));
  try {
    writeFileSync(
      join(dir, "use.ts"),
      [
        `import { AbgeordnetenwatchClient, type EngineOptions, type ListParams } from ${JSON.stringify(INDEX)};`,
        "declare function allUndefined<T>(): { [K in keyof T]-?: undefined };",
        "export const a: EngineOptions = allUndefined<EngineOptions>();",
        "export const b: ListParams = allUndefined<ListParams>();",
        "export const c = new AbgeordnetenwatchClient({ baseUrl: process.env.AW_BASE_URL, timeoutMs: 15_000 });",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules/@types")],
        },
        files: ["use.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
    const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
      execFile(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr }),
      );
    });
    assert.equal(result.code, 0, result.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an option given as undefined means the default, as an omitted one does (bug 2, 2026-10-20)", async () => {
  const mt = makeMockTransport(() => jsonResponse({ meta: { status: "ok", result: { total: 0 } }, data: [] }));
  const client = new AbgeordnetenwatchClient({
    baseUrl: undefined,
    userAgent: undefined,
    headers: undefined,
    timeoutMs: undefined,
    maxRetries: undefined,
    retryDelayMs: undefined,
    maxRedirects: undefined,
    maxResponseBytes: undefined,
    sleep: undefined,
    onRetry: undefined,
    transport: mt.transport,
  });
  await client.list("parties", { rangeStart: undefined, rangeEnd: undefined, sortBy: undefined, sortDirection: undefined, filters: undefined });
  assert.equal(mt.calls[0]!.url, "https://www.abgeordnetenwatch.de/api/v2/parties");
});
