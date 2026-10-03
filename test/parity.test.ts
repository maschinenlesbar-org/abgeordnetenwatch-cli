// CLI <-> library parity: the same input through run() and through the library
// call the CLI makes must give the same outcome. Either both reject before any
// request (the CLI with a usage error, the library with AwValidationError), or both
// send the identical request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AbgeordnetenwatchClient } from "../src/client/client.js";
import { AwNetworkError, AwValidationError } from "../src/client/errors.js";
import type { ListParams } from "../src/client/types.js";
import { parity, type CliOutcome, type LibOutcome } from "./helpers.js";

type Outcome = { cli: CliOutcome; lib: LibOutcome };

function assertBothReject({ cli, lib }: Outcome, label: string): void {
  assert.equal(cli.code, 2, `CLI exit for ${label}: ${cli.err}`);
  assert.equal(cli.requests.length, 0, `CLI requests for ${label}`);
  assert.equal(lib.ok, false, `library resolved for ${label}`);
  if (!lib.ok) {
    assert.ok(lib.error instanceof AwValidationError, `library error for ${label}: ${String(lib.error)}`);
  }
  assert.equal(lib.requests.length, 0, `library requests for ${label}`);
}

function assertSameRequests({ cli, lib }: Outcome, label: string): void {
  assert.equal(cli.code, 0, `CLI exit for ${label}: ${cli.err}`);
  assert.equal(lib.ok, true, `library rejected ${label}: ${lib.ok ? "" : String(lib.error)}`);
  assert.ok(cli.requests.length > 0, label);
  assert.deepEqual(
    lib.requests.map((r) => r.url),
    cli.requests.map((r) => r.url),
    label,
  );
}

const detail = () => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: Buffer.from(JSON.stringify({ meta: {}, data: { id: 2 } })),
});

test("parity: get with an invalid entity id", async () => {
  for (const id of ["0", "000", "", " 2 ", "abc", "-1", "1.5", "2a", "1e3"]) {
    const p = await parity(
      ["get", "parties", id],
      (transport) => new AbgeordnetenwatchClient({ transport }).get("parties", id),
      detail,
    );
    assertBothReject(p, JSON.stringify(id));
  }
});

test("parity: get with a valid or zero-padded entity id", async () => {
  for (const id of ["2", "0002", "007", "184945"]) {
    const p = await parity(
      ["get", "parties", id],
      (transport) => new AbgeordnetenwatchClient({ transport }).get("parties", id),
      detail,
    );
    assertSameRequests(p, JSON.stringify(id));
  }
});

/** The filters object the CLI builds from `key=value` tokens (split at the first `=`). */
function filtersOf(tokens: string[]): Record<string, string> {
  return Object.fromEntries(tokens.map((t) => [t.slice(0, t.indexOf("=")), t.slice(t.indexOf("=") + 1)]));
}

const listBody = () => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: Buffer.from(JSON.stringify({ meta: { result: { total: 1234 } }, data: [] })),
});

test("parity: list and count with a blank, malformed, reserved or clashing filter", async () => {
  const cases: string[][] = [
    ["sex="],
    ["sex= "],
    [" =f"],
    ["[gt]=1990"],
    ["year_of_birth[gt]x=1990"],
    ["a.b=1"],
    ["last_name[zz]=x"],
    ["last_name[]=x"],
    ["year_of_birth=1990", "year_of_birth[gt]=2000"],
    ["year_of_birth[gt]=2000", "year_of_birth=1990"],
    ["range_start=5"],
    ["range_end=5"],
    ["range_end=5000"],
    ["sort_by=id"],
    ["sort_direction=up"],
    ["range_end[gt]=5"],
  ];
  for (const command of ["list", "count"] as const) {
    for (const tokens of cases) {
      const p = await parity(
        [command, "politicians", ...tokens],
        (transport) =>
          new AbgeordnetenwatchClient({ transport })[command]("politicians", { filters: filtersOf(tokens) }),
        listBody,
      );
      assertBothReject(p, `${command} ${tokens.join(" ")}`);
    }
  }
});

test("parity: list and count with valid filters send the same request", async () => {
  for (const command of ["list", "count"] as const) {
    for (const tokens of [
      ["sex=f", "year_of_birth[gt]=1990"],
      ["year_of_birth[gt]=1990", "year_of_birth[lt]=2000"],
      ["politician=184945"],
      ["last_name[cn]=a=b"],
    ]) {
      const p = await parity(
        [command, "politicians", ...tokens],
        (transport) =>
          new AbgeordnetenwatchClient({ transport })[command]("politicians", { filters: filtersOf(tokens) }),
        listBody,
      );
      assertSameRequests(p, `${command} ${tokens.join(" ")}`);
    }
  }
});

test("parity: list with invalid paging or sort options", async () => {
  const cases: [string[], ListParams][] = [
    [["--sort-direction", "asc"], { sortDirection: "asc" }],
    [["--sort-by", ""], { sortBy: "" }],
    [["--sort-by", "   "], { sortBy: "   " }],
    [["--sort-by", "id", "--sort-direction", "ASC"], { sortBy: "id", sortDirection: "ASC" as "asc" }],
    [["--sort-by", "id", "--sort-direction", ""], { sortBy: "id", sortDirection: "" as "asc" }],
    [["--range-start", "-1"], { rangeStart: -1 }],
    [["--range-start", "1.5"], { rangeStart: 1.5 }],
    [["--range-start", "99999999999999999999"], { rangeStart: 1e20 }],
    [["--range-end", "1.5"], { rangeEnd: 1.5 }],
    [["--range-end", "NaN"], { rangeEnd: NaN }],
    [["--range-end", "Infinity"], { rangeEnd: Infinity }],
  ];
  for (const [options, params] of cases) {
    const p = await parity(
      ["list", "politicians", ...options],
      (transport) => new AbgeordnetenwatchClient({ transport }).list("politicians", params),
      listBody,
    );
    assertBothReject(p, options.join(" "));
  }
});

test("parity: list with valid paging and sort options sends the same request", async () => {
  const cases: [string[], ListParams][] = [
    [
      ["--sort-by", "last_name", "--sort-direction", "desc", "--range-start", "10", "--range-end", "5"],
      { sortBy: "last_name", sortDirection: "desc", rangeStart: 10, rangeEnd: 5 },
    ],
    [["--sort-by", "id"], { sortBy: "id" }],
    [["--range-start", "0", "--range-end", "0"], { rangeStart: 0, rangeEnd: 0 }],
  ];
  for (const [options, params] of cases) {
    const p = await parity(
      ["list", "politicians", ...options],
      (transport) => new AbgeordnetenwatchClient({ transport }).list("politicians", params),
      listBody,
    );
    assertSameRequests(p, options.join(" "));
  }
});

test("parity: an invalid User-Agent is rejected before any request", async () => {
  for (const ua of ["", " ", "a\r\nX-Injected: 1", "a\u0000b", `a${String.fromCharCode(0x7f)}`, "€uro"]) {
    const p = await parity(
      ["--user-agent", ua, "list", "parties"],
      (transport) => new AbgeordnetenwatchClient({ userAgent: ua, transport }).list("parties"),
      listBody,
    );
    assertBothReject(p, JSON.stringify(ua));
  }
});

test("parity: a valid User-Agent is sent as is", async () => {
  for (const ua of ["my-ua/1.0", "müller-bot/1.0\t(test)"]) {
    const p = await parity(
      ["--user-agent", ua, "list", "parties"],
      (transport) => new AbgeordnetenwatchClient({ userAgent: ua, transport }).list("parties"),
      listBody,
    );
    assertSameRequests(p, JSON.stringify(ua));
    assert.equal(p.lib.requests[0]?.headers?.["User-Agent"], ua);
    assert.equal(p.cli.requests[0]?.headers?.["User-Agent"], ua);
  }
});

test("parity: a base URL with surrounding whitespace is rejected before any request", async () => {
  for (const baseUrl of [
    "https://api.example.test/ ",
    "https://api.example.test ",
    " https://api.example.test",
    "https://api.example.test\n",
    "\thttps://api.example.test",
    "https://api.example.test/\t",
  ]) {
    const p = await parity(
      ["--base-url", baseUrl, "list", "parties"],
      (transport) => new AbgeordnetenwatchClient({ baseUrl, transport }).list("parties"),
      listBody,
    );
    assertBothReject(p, JSON.stringify(baseUrl));
  }
});

test("parity: a valid base URL with a path prefix sends the same request", async () => {
  for (const baseUrl of ["https://mirror.example/aw/", "http://127.0.0.1:8080"]) {
    const p = await parity(
      ["--base-url", baseUrl, "list", "parties"],
      (transport) => new AbgeordnetenwatchClient({ baseUrl, transport }).list("parties"),
      listBody,
    );
    assertSameRequests(p, baseUrl);
  }
});

test("parity: a base URL with a query or fragment is a validation error, not a network error", async () => {
  for (const baseUrl of ["https://example.org/?x=1", "https://example.org/#frag", "https://example.org?"]) {
    const p = await parity(
      ["--base-url", baseUrl, "list", "parties"],
      (transport) => new AbgeordnetenwatchClient({ baseUrl, transport }).list("parties"),
      listBody,
    );
    assertBothReject(p, baseUrl);
    assert.ok(!p.lib.ok && !(p.lib.error instanceof AwNetworkError), baseUrl);
  }
});
