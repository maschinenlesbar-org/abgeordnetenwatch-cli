// CLI <-> library parity: the same input through run() and through the library
// call the CLI makes must give the same outcome. Either both reject before any
// request (the CLI with a usage error, the library with AwValidationError), or both
// send the identical request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AbgeordnetenwatchClient } from "../src/client/client.js";
import { AwValidationError } from "../src/client/errors.js";
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
