import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import { AbgeordnetenwatchClient } from "../src/client/client.js";
import { AwApiError } from "../src/client/errors.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { jsonResponse, makeMockTransport, rawResponse } from "./helpers.js";

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

/** Build CliDeps with a real client over a mock transport and capturing IO. */
function makeTransportDeps(responder: (req: HttpRequest) => HttpResponse) {
  const cap: Captured = { out: [], err: [] };
  const mt = makeMockTransport(responder);
  const deps: CliDeps = {
    io: {
      out: (t) => cap.out.push(t),
      err: (t) => cap.err.push(t),
    },
    createClient: (options) => new AbgeordnetenwatchClient({ ...options, transport: mt.transport }),
  };
  return { deps, cap, mt };
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

test("a plain and a bracket filter on the same field conflict (the API keeps only one)", async () => {
  for (const filters of [
    ["year_of_birth=1990", "year_of_birth[gt]=2000"],
    ["year_of_birth[gt]=2000", "year_of_birth=1990"],
    ["sex=f", "sex[ne]=f"],
    ["sex[eq]=f", "year_of_birth[gt]=1990", "sex=m"],
  ]) {
    const { deps, cap, mt } = makeTransportDeps(() => jsonResponse({ meta: {}, data: [] }));
    const code = await run(["count", "politicians", ...filters], deps);
    assert.equal(code, 2, filters.join(" "));
    assert.equal(mt.calls.length, 0);
    assert.match(cap.err.join("\n"), /Conflicting filters "[a-z_]+(\[[a-z]+\])?" and "[a-z_]+(\[[a-z]+\])?"/);
  }
});

test("a filter key that is not a field name with at most one operator is a usage error", async () => {
  for (const filter of [
    "[gt]=1990",
    "year_of_birth[gt]x=1990",
    "year_of_birth[gt][lt]=1990",
    "year of birth=1990",
    "1field=2",
    "field]=2",
  ]) {
    const { deps, cap, mt } = makeTransportDeps(() => jsonResponse({ meta: {}, data: [] }));
    const code = await run(["count", "politicians", filter], deps);
    assert.equal(code, 2, filter);
    assert.equal(mt.calls.length, 0, filter);
    assert.match(cap.err.join("\n"), /Invalid filter key/, filter);
  }
});

test("paging and sort parameter names are rejected as filters, pointing to the option", async () => {
  for (const [filter, option] of [
    ["range_end=5000", "--range-end"],
    ["range_start=-5", "--range-start"],
    ["sort_by=id", "--sort-by"],
    ["sort_direction=sideways", "--sort-direction"],
    ["range_end[gt]=1", "--range-end"],
  ] as const) {
    for (const command of ["list", "count"]) {
      const { deps, cap, mt } = makeTransportDeps(() => jsonResponse({ meta: {}, data: [] }));
      const code = await run([command, "parties", filter], deps);
      assert.equal(code, 2, `${command} ${filter}`);
      assert.equal(mt.calls.length, 0);
      assert.match(cap.err.join("\n"), new RegExp(`not a filter\\. Use ${option} on list`));
    }
  }
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

test("get drops leading zeros from the id (the API does not find 0002)", async () => {
  const { deps, mt } = makeTransportDeps(() => jsonResponse({ meta: {}, data: { id: 2 } }));
  assert.equal(await run(["get", "parties", "0002"], deps), 0);
  assert.match(mt.last().url, /\/api\/v2\/parties\/2$/);
});

test("--sort-direction without --sort-by is a usage error, before any request", async () => {
  const { deps, cap, mt } = makeTransportDeps(() => jsonResponse({ meta: {}, data: [] }));
  assert.equal(await run(["list", "politicians", "--sort-direction", "asc"], deps), 2);
  assert.equal(mt.calls.length, 0);
  assert.match(cap.err.join("\n"), /--sort-direction needs --sort-by/);

  const ok = makeTransportDeps(() => jsonResponse({ meta: {}, data: [] }));
  assert.equal(await run(["list", "politicians", "--sort-by", "last_name", "--sort-direction", "asc"], ok.deps), 0);
  assert.match(ok.mt.last().url, /sort_by=last_name&sort_direction=asc/);
});

test("an invalid --sort-direction is rejected client-side", async () => {
  const { deps, cap } = makeDeps({});
  const code = await run(["list", "politicians", "--sort-direction", "sideways"], deps);
  assert.equal(code, 2);
  assert.match(cap.err.join("\n"), /Invalid sort direction "sideways"/);
});

test("a --user-agent with CR/LF is rejected, not an unexpected crash", async () => {
  const { deps, cap } = makeDeps({});
  const code = await run(["--user-agent", "bad\r\nInjected: x", "entities", "--compact"], deps);
  assert.equal(code, 2);
  assert.match(cap.err.join("\n"), /Value contains control characters\./);
  // Must not leak the old catch-all message.
  assert.doesNotMatch(cap.err.join("\n"), /Unexpected error/);
});

test("--user-agent that is blank or outside Latin-1 is a usage error, not an 'Unexpected error'", async () => {
  for (const [ua, message] of [
    [`a${String.fromCharCode(0x7f)}`, /Value contains control characters\./],
    ["\u20acuro", /Value contains characters outside Latin-1/],
    ["", /Expected a non-empty value/],
    [" ", /Expected a non-empty value/],
  ] as const) {
    const { deps, cap, mt } = makeTransportDeps(() => jsonResponse({ meta: {}, data: { id: 5 } }));
    const code = await run(["--user-agent", ua, "get", "parties", "5"], deps);
    assert.equal(code, 2, JSON.stringify(ua));
    assert.equal(mt.calls.length, 0);
    assert.match(cap.err.join("\n"), message);
  }
  const { deps, mt } = makeTransportDeps(() => jsonResponse({ meta: {}, data: { id: 5 } }));
  assert.equal(await run(["--user-agent", "müller-bot/1.0\t(test)", "get", "parties", "5"], deps), 0);
  assert.equal(mt.last().headers?.["User-Agent"], "müller-bot/1.0\t(test)");
});

test("a 429 prints rate-limit guidance and exits 1", async () => {
  const { deps, cap } = makeDeps({
    list: (async () => {
      throw new AwApiError({
        status: 429,
        url: "u",
        method: "GET",
        body: "",
        detail: "Too Many Requests",
      });
    }) as unknown as AbgeordnetenwatchClient["list"],
  });
  const code = await run(["list", "politicians"], deps);
  assert.equal(code, 1);
  assert.match(cap.err.join("\n"), /rate-limiting or temporarily unavailable/);
  assert.match(cap.err.join("\n"), /--max-retries/);
});

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const served = {
    meta: { status: "ok" },
    data: { id: 42, label: `CDU${controls}`, full_name: String.fromCharCode(0x1b) + "[31m" },
  };
  for (const format of [[], ["--compact"]]) {
    const { deps, cap } = makeTransportDeps(() => jsonResponse(served));
    assert.equal(await run(["get", "parties", "42", ...format], deps), 0);
    const text = cap.out.join("\n");
    const raw = [...text].filter((c) =>
      c.charCodeAt(0) < 0x20 ? c !== "\n" : c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f,
    );
    assert.deepEqual(raw, [], format.join(" "));
    assert.match(text, /CDU\\u007f\\u0085\\u009b2J/);
    assert.deepEqual(JSON.parse(text), served);
  }
});

test("--timeout accepts up to the largest timer Node supports", async () => {
  const served = { meta: { status: "ok" }, data: { id: 42 } };
  const ok = makeTransportDeps(() => jsonResponse(served));
  assert.equal(await run(["--timeout", "2147483647", "get", "parties", "42"], ok.deps), 0);
  assert.equal(ok.mt.last().timeoutMs, 2_147_483_647);

  const over = makeTransportDeps(() => jsonResponse(served));
  assert.equal(await run(["--timeout", "2147483648", "get", "parties", "42"], over.deps), 2);
  assert.equal(over.mt.calls.length, 0);
  assert.match(over.cap.err.join("\n"), /between 0 and 2147483647/);
});

test("a non-http(s) or malformed --base-url is a usage error, before any request", async () => {
  for (const url of ["file:///etc/passwd", "ftp://example.org", "notaurl"]) {
    const { deps, cap, mt } = makeTransportDeps(() => jsonResponse({ meta: {}, data: {} }));
    const code = await run(["--base-url", url, "get", "parties", "42"], deps);
    assert.notEqual(code, 0, url);
    assert.equal(mt.calls.length, 0, url);
    assert.match(cap.err.join("\n"), /--base-url/, url);
  }
});

test("a --base-url with a query, a fragment or surrounding whitespace is a usage error", async () => {
  for (const [baseUrl, message] of [
    ["http://127.0.0.1:18101/ok?x=1", /cannot have a query \(\?\) or fragment \(#\)/],
    ["http://127.0.0.1:18101/ok#frag", /cannot have a query \(\?\) or fragment \(#\)/],
    ["http://127.0.0.1:18101?", /cannot have a query \(\?\) or fragment \(#\)/],
    [" https://www.abgeordnetenwatch.de", /cannot have surrounding whitespace/],
    ["https://www.abgeordnetenwatch.de\t", /cannot have surrounding whitespace/],
  ] as const) {
    const { deps, cap, mt } = makeTransportDeps(() => jsonResponse({ meta: {}, data: {} }));
    const code = await run(["--base-url", baseUrl, "get", "parties", "5"], deps);
    assert.equal(code, 2, baseUrl);
    assert.equal(mt.calls.length, 0, baseUrl);
    assert.match(cap.err.join("\n"), message, baseUrl);
  }
});

test("a --base-url with a path prefix still works", async () => {
  const { deps, mt } = makeTransportDeps(() => jsonResponse({ meta: {}, data: { id: 5 } }));
  assert.equal(await run(["--base-url", "https://mirror.example/aw/", "get", "parties", "5"], deps), 0);
  assert.equal(mt.last().url, "https://mirror.example/aw/api/v2/parties/5");
});

test("blank filter, sort key and filter tokens are usage errors, before any request", async () => {
  const cases: string[][] = [
    ["list", "politicians", "--sort-by", ""],
    ["list", "politicians", "--sort-by", "   "],
    ["list", "politicians", ""],
    ["list", "politicians", "sex="],
    ["list", "politicians", "sex=  "],
    ["list", "politicians", " =f"],
    ["count", "politicians", ""],
    ["count", "politicians", "sex="],
    ["count", "politicians", "sex=  "],
    ["count", "politicians", " =f"],
  ];
  for (const argv of cases) {
    const { deps, mt } = makeTransportDeps(() => jsonResponse({ meta: {}, data: [] }));
    const code = await run(argv, deps);
    assert.notEqual(code, 0, JSON.stringify(argv));
    assert.equal(mt.calls.length, 0, JSON.stringify(argv));
  }
});

test("a malformed 2xx envelope exits 1 with a parse error, not an unexpected TypeError", async () => {
  for (const argv of [["count", "parties"], ["list", "parties", "--data-only"], ["get", "parties", "5"]]) {
    const { deps, cap } = makeTransportDeps(() => jsonResponse(null));
    assert.equal(await run(argv, deps), 1, argv.join(" "));
    assert.deepEqual(cap.out, []);
    assert.match(cap.err.join("\n"), /^Error: Unexpected response shape from \/api\/v2\/parties/);
  }
});

test("--max-retries is bounded to 0..10", async () => {
  for (const [value, ok] of [["0", true], ["10", true], ["11", false], ["99999999999", false]] as const) {
    const { deps, cap, mt } = makeTransportDeps(() => jsonResponse({ meta: {}, data: { id: 5 } }));
    const code = await run(["--max-retries", value, "get", "parties", "5"], deps);
    assert.equal(code, ok ? 0 : 2, value);
    if (!ok) {
      assert.equal(mt.calls.length, 0);
      assert.match(cap.err.join("\n"), /must be between 0 and 10/);
    }
  }
});

test("a message-less HTTP 500 hints at the filters only when the request had filters", async () => {
  for (const [argv, hint] of [
    [["get", "parties", "1"], false],
    [["list", "parties", "--range-end", "5"], false],
    [["count", "parties"], false],
    [["list", "politicians", "year_of_birth[gt]=1990"], true],
    [["count", "politicians", "sex=f"], true],
  ] as const) {
    const { deps, cap } = makeTransportDeps(() => jsonResponse({}, 500));
    assert.equal(await run([...argv], deps), 1, argv.join(" "));
    assert.match(cap.err.join("\n"), /^Error: HTTP 500 for GET /);
    assert.equal(/Hint: .*filter field names/.test(cap.err.join("\n")), hint, argv.join(" "));
    assert.doesNotMatch(cap.err.join("\n"), /filter operator/);
  }
});

test("credentials in --base-url are redacted from error messages", async () => {
  const { deps, cap, mt } = makeTransportDeps(() => jsonResponse({}, 418));
  const code = await run(["--base-url", "http://user:secret@127.0.0.1:18101/e418", "list", "parties"], deps);
  assert.equal(code, 1);
  // ...but still sent: the request URL keeps the userinfo (Node turns it into Basic auth).
  assert.equal(mt.last().url, "http://user:secret@127.0.0.1:18101/e418/api/v2/parties");
  assert.equal(cap.err.join("\n"), "Error: HTTP 418 for GET http://***@127.0.0.1:18101/e418/api/v2/parties");
});

test("a deeply nested response fails pretty-printing cleanly and still prints with --compact", async () => {
  const depth = 200_000;
  const deep = () => rawResponse(`{"meta":{},"data":{"x":${"[".repeat(depth)}${"]".repeat(depth)}}}`, "application/json");
  const pretty = makeTransportDeps(deep);
  assert.equal(await run(["get", "parties", "5"], pretty.deps), 1);
  assert.deepEqual(pretty.cap.out, []);
  assert.equal(pretty.cap.err.join("\n"), "Error: The response is nested too deeply to pretty-print; try --compact.");

  // Compact serialisation goes much deeper (it prints this one on current Node);
  // should a runtime's stack still be too small, it must fail just as cleanly.
  const compact = makeTransportDeps(deep);
  const code = await run(["--compact", "get", "parties", "5"], compact.deps);
  if (code === 0) assert.ok(compact.cap.out.join("").length > 2 * depth);
  else assert.equal(compact.cap.err.join("\n"), "Error: The response is nested too deeply to print.");
});

test("--help exits 0", async () => {
  const { deps } = makeDeps({});
  assert.equal(await run(["--help"], deps), 0);
});

test("the help subcommand exits 0; a bare invocation is a usage error", async () => {
  for (const [argv, code] of [
    [["help"], 0],
    [["help", "list"], 0],
    [["list", "--help"], 0],
    [["--version"], 0],
    [[], 2],
    [["help", "nope"], 2],
  ] as const) {
    const { deps, cap } = makeDeps({});
    assert.equal(await run([...argv], deps), code, argv.join(" ") || "(bare)");
    assert.ok(cap.out.length + cap.err.length > 0, argv.join(" ") || "(bare)");
  }
});
