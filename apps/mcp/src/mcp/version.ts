// The app's version, read from its own package.json: dist/src/mcp/version.js -> ../../../package.json
// (apps/mcp/package.json in the repository, package/package.json in the tarball).

import { readFileSync } from "node:fs";

export const VERSION: string = (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string }).version;

export const PROGRAM = "abgeordnetenwatch-mcp";

export const USER_AGENT = `${PROGRAM}/${VERSION}`;
