// The container's limits, read from its cgroup (v2, then v1), for what the CLI can't otherwise
// see: in a memory-limited container, a response cap that the memory can't hold turns an
// oversized answer into the kernel's OOM kill (exit 137, nothing said) instead of the cap's error.
// Outside a container (or on macOS) nothing is found and nothing changes.

import { readFileSync } from "node:fs";

export interface ContainerLimits {
  /** The memory limit in bytes, when there is one. */
  memoryBytes?: number;
  /** The most processes and threads, when there is a limit. */
  pids?: number;
}

/** The client's default response cap (100 MiB), the most a memory-derived cap gives. */
export const DEFAULT_RESPONSE_CAP = 100 * 1024 * 1024;

// cgroup v1 writes "no limit" as a huge number (about 2^63) instead of "max".
const UNLIMITED = 2 ** 50;

/** The limits in the cgroup files, read with `read` (default: the file system). */
export function readContainerLimits(read: (path: string) => string = (path) => readFileSync(path, "utf8")): ContainerLimits {
  const first = (...paths: string[]): number | undefined => {
    for (const path of paths) {
      let text: string;
      try {
        text = read(path).trim();
      } catch {
        continue;
      }
      if (!/^\d+$/.test(text)) return undefined; // "max": no limit
      const value = Number(text);
      return Number.isSafeInteger(value) && value < UNLIMITED ? value : undefined;
    }
    return undefined;
  };
  const memoryBytes = first("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes");
  const pids = first("/sys/fs/cgroup/pids.max", "/sys/fs/cgroup/pids/pids.max");
  return { ...(memoryBytes === undefined ? {} : { memoryBytes }), ...(pids === undefined ? {} : { pids }) };
}

/**
 * The default response cap under a memory limit: an eighth of it (decoding and parsing an answer
 * takes several times its size), at least 1 MiB, at most the client's default.
 */
export function responseCapFor(memoryBytes: number): number {
  return Math.min(DEFAULT_RESPONSE_CAP, Math.max(1024 * 1024, Math.floor(memoryBytes / 8)));
}
