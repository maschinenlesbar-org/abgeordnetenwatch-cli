import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import type { AbgeordnetenwatchClient } from "../src/client/client.js";
import { AwApiError } from "../src/client/errors.js";

interface Captured {
  out: string[];
  err: string[];
}

/** Build CliDeps with a stub client and capturing IO. */
function makeDeps(client: Partial<AbgeordnetenwatchClient>): { deps: CliDeps; cap: Captured } {
  const cap: Captured = { out: [], err: [] };
  const deps: CliDeps = {
    io: {
      out: (t) => cap.out.push(t),
      err: (t) => cap.err.push(t),
    },
    createClient: () => client as AbgeordnetenwatchClient,
  };
  return { deps, cap };
}

test("`entities` lists all collections without touching the network", async () => {
  const { deps, cap } = makeDeps({});
  const code = await run(["entities", "--compact"], deps);
  assert.equal(code, 0);
  const parsed = JSON.parse(cap.out.join("")) as { entities: string[] };
  assert.ok(parsed.entities.includes("politicians"));
  assert.ok(parsed.entities.includes("election-program"));
  assert.equal(parsed.entities.length, 18);
});

test("`list` passes entity + params to the client and prints the envelope", async () => {
  let received: unknown;
  const env = { meta: { result: { total: 1 } }, data: [{ id: 1 }] };
  const { deps, cap } = makeDeps({
    list: (async (entity: string, params: unknown) => {
      received = { entity, params };
      return env;
    }) as unknown as AbgeordnetenwatchClient["list"],
  });

  const code = await run(
    ["list", "politicians", "sex=f", "year_of_birth[gt]=1990", "--range-end", "5", "--compact"],
    deps,
  );
  assert.equal(code, 0);
  assert.deepEqual(received, {
    entity: "politicians",
    params: { rangeEnd: 5, filters: { sex: "f", "year_of_birth[gt]": "1990" } },
  });
  assert.equal(cap.out.join(""), JSON.stringify(env));
});

test("`list --data-only` prints just the data array", async () => {
  const env = { meta: {}, data: [{ id: 1 }, { id: 2 }] };
  const { deps, cap } = makeDeps({ list: (async () => env) as unknown as AbgeordnetenwatchClient["list"] });
  const code = await run(["list", "votes", "--data-only", "--compact"], deps);
  assert.equal(code, 0);
  assert.equal(cap.out.join(""), JSON.stringify(env.data));
});

test("`count` prints { entity, total }", async () => {
  const { deps, cap } = makeDeps({
    count: (async () => 9619) as unknown as AbgeordnetenwatchClient["count"],
  });
  const code = await run(["count", "politicians", "sex=f", "--compact"], deps);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(cap.out.join("")), { entity: "politicians", total: 9619 });
});

test("an unknown entity is a usage error (exit 2) listing valid names", async () => {
  const { deps, cap } = makeDeps({});
  const code = await run(["list", "wizards"], deps);
  assert.equal(code, 2);
  assert.match(cap.err.join("\n"), /Unknown entity "wizards"/);
  assert.match(cap.err.join("\n"), /politicians/);
});

test("a malformed filter is a usage error (exit 2) and prints guidance", async () => {
  const { deps, cap } = makeDeps({});
  const code = await run(["list", "politicians", "notafilter"], deps);
  assert.equal(code, 2);
  // The guidance must reach the user, not be swallowed (regression: a filter
  // rejected from inside the action exited 2 with empty stdout AND stderr).
  assert.match(cap.err.join("\n"), /Invalid filter "notafilter"/);
  assert.match(cap.err.join("\n"), /key=value/);
});

test("a filter with an empty key is rejected with guidance", async () => {
  const { deps, cap } = makeDeps({});
  const code = await run(["count", "politicians", "=f"], deps);
  assert.equal(code, 2);
  assert.match(cap.err.join("\n"), /Invalid filter "=f"/);
});

test("a duplicate filter key is rejected (no silent last-wins)", async () => {
  const { deps, cap } = makeDeps({});
  const code = await run(["list", "politicians", "sex=f", "sex=m"], deps);
  assert.equal(code, 2);
  assert.match(cap.err.join("\n"), /Duplicate filter key "sex"/);
});

test("distinct operators on the same field are allowed (not a duplicate)", async () => {
  let received: unknown;
  const { deps } = makeDeps({
    list: (async (_entity: string, params: { filters?: unknown }) => {
      received = params.filters;
      return { meta: {}, data: [] };
    }) as unknown as AbgeordnetenwatchClient["list"],
  });
  const code = await run(
    ["list", "politicians", "year_of_birth[gt]=1980", "year_of_birth[lt]=1990", "--compact"],
    deps,
  );
  assert.equal(code, 0);
  assert.deepEqual(received, { "year_of_birth[gt]": "1980", "year_of_birth[lt]": "1990" });
});

test("an unknown bracket filter operator is rejected client-side", async () => {
  const { deps, cap } = makeDeps({});
  const code = await run(["list", "politicians", "last_name[zz]=A"], deps);
  assert.equal(code, 2);
  assert.match(cap.err.join("\n"), /Unknown filter operator "\[zz\]"/);
  assert.match(cap.err.join("\n"), /eq, ne, gt/);
});

test("a 404 from the client maps to exit code 4", async () => {
  const { deps, cap } = makeDeps({
    get: (async () => {
      throw new AwApiError({
        status: 404,
        url: "u",
        method: "GET",
        body: "",
        detail: "There is no party entity with id 99999999",
      });
    }) as unknown as AbgeordnetenwatchClient["get"],
  });
  const code = await run(["get", "parties", "99999999"], deps);
  assert.equal(code, 4);
  assert.match(cap.err.join("\n"), /no party entity/);
});

test("get rejects id 0 client-side (it dumped the whole collection)", async () => {
  const { deps, cap } = makeDeps({});
  const code = await run(["get", "politicians", "0"], deps);
  assert.equal(code, 2);
  assert.match(cap.err.join("\n"), /Invalid id "0"/);
});

test("get rejects a non-numeric id client-side", async () => {
  const { deps, cap } = makeDeps({});
  const code = await run(["get", "politicians", "abc"], deps);
  assert.equal(code, 2);
  assert.match(cap.err.join("\n"), /Invalid id "abc"/);
});

test("get forwards a valid numeric id to the client", async () => {
  let received: unknown;
  const { deps } = makeDeps({
    get: (async (entity: string, id: unknown) => {
      received = { entity, id };
      return { meta: {}, data: { id: 42 } };
    }) as unknown as AbgeordnetenwatchClient["get"],
  });
  const code = await run(["get", "parties", "42", "--compact"], deps);
  assert.equal(code, 0);
  assert.deepEqual(received, { entity: "parties", id: "42" });
});

test("an invalid --sort-direction is rejected client-side", async () => {
  const { deps, cap } = makeDeps({});
  const code = await run(["list", "politicians", "--sort-direction", "sideways"], deps);
  assert.equal(code, 2);
  assert.match(cap.err.join("\n"), /Invalid sort direction "sideways"/);
});

test("--help exits 0", async () => {
  const { deps } = makeDeps({});
  assert.equal(await run(["--help"], deps), 0);
});
