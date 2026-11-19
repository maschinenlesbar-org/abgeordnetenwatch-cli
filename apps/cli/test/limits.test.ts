// Container limits (cgroup v2 and v1) and what the CLI does with them: in a memory-limited
// container the default response cap follows the memory, so an oversized answer meets the cap's
// error before the kernel's OOM kill (exit 137, nothing said).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readContainerLimits, responseCapFor } from "../src/cli/limits.js";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import type { AbgeordnetenwatchClient } from "@maschinenlesbar.org/abgeordnetenwatch-client/internal/client";

const MiB = 1024 * 1024;
const files = (map: Record<string, string>) => (path: string) => {
  const text = map[path];
  if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  return text;
};

test("cgroup v2 limits are read; 'max' and missing files mean no limit", () => {
  assert.deepEqual(readContainerLimits(files({ "/sys/fs/cgroup/memory.max": "134217728\n", "/sys/fs/cgroup/pids.max": "64\n" })), { memoryBytes: 128 * MiB, pids: 64 });
  assert.deepEqual(readContainerLimits(files({ "/sys/fs/cgroup/memory.max": "max\n", "/sys/fs/cgroup/pids.max": "max\n" })), {});
  assert.deepEqual(readContainerLimits(files({})), {});
});

test("cgroup v1 limits are read; its 'unlimited' (a huge number) means no limit", () => {
  assert.deepEqual(readContainerLimits(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "268435456\n", "/sys/fs/cgroup/pids/pids.max": "8\n" })), { memoryBytes: 256 * MiB, pids: 8 });
  assert.deepEqual(readContainerLimits(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n" })), {});
});

test("the response cap is an eighth of the memory, at least 1 MiB, at most the 100 MiB default", () => {
  assert.equal(responseCapFor(128 * MiB), 16 * MiB);
  assert.equal(responseCapFor(4 * MiB), 1 * MiB);
  assert.equal(responseCapFor(64 * 1024 * MiB), 100 * MiB);
});

/** The maxResponseBytes the CLI gives the client, under the given limits and argv. */
async function capUnder(limits: { memoryBytes?: number }, extra: string[] = []): Promise<number | undefined> {
  let seen: number | undefined;
  const deps: CliDeps = {
    io: { out: () => {}, err: () => {} },
    createClient: (options) => {
      seen = options.maxResponseBytes;
      return { count: async () => 1 } as unknown as AbgeordnetenwatchClient;
    },
    limits: () => limits,
  };
  assert.equal(await run([...extra, "count", "parties"], deps), 0);
  return seen;
}

test("in a memory-limited container the default cap follows the memory; --max-response-bytes still wins", async () => {
  assert.equal(await capUnder({ memoryBytes: 128 * MiB }), 16 * MiB);
  assert.equal(await capUnder({}), 100 * MiB, "no limit: the option's default, 100 MiB");
  assert.equal(await capUnder({ memoryBytes: 128 * MiB }, ["--max-response-bytes", "5000"]), 5000);
});

test("under a pids limit below 12 a request is refused with one ERROR record and exit 1, not a crash", async () => {
  const run8 = async (pids: number) => {
    const err: string[] = [];
    let created = false;
    const deps: CliDeps = {
      io: { out: () => {}, err: (text) => err.push(text) },
      createClient: () => {
        created = true;
        return { count: async () => 1 } as unknown as AbgeordnetenwatchClient;
      },
      limits: () => ({ pids }),
    };
    return { code: await run(["count", "parties"], deps), err: err.join(""), created };
  };
  const tight = await run8(8);
  assert.equal(tight.code, 1);
  assert.equal(tight.created, false, "no request is attempted");
  assert.match(tight.err, /ERROR \[abgeordnetenwatch\.cli\] the container allows only 8 processes and threads \(--pids-limit 8\); the CLI needs at least 12\. Run it with --pids-limit 12 or more\./);
  const enough = await run8(12);
  assert.equal(enough.code, 0);
});
