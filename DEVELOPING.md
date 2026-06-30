# Developing

`abgeordnetenwatch-cli` is a small, dependency-light TypeScript package: a typed
API client plus a [commander](https://github.com/tj/commander.js)-based CLI.
The only runtime dependency is `commander`; everything else (HTTP, retries,
JSON) is built on Node's standard library.

## Layout

```
src/
  client/
    http.ts      Node http/https transport (swappable for tests)
    engine.ts    request engine: URL building, retries (429/503), redirects, JSON decode
    query.ts     dependency-free query-string builder
    errors.ts    AwError / AwApiError / AwNetworkError / AwParseError
    types.ts     envelope + entity types, the ENTITY_COLLECTIONS list
    client.ts    AbgeordnetenwatchClient — generic list/get/count over a collection
    index.ts     public library surface
  cli/
    index.ts     #! bin shim → run()
    run.ts       argv → exit code, error→exit-code mapping
    program.ts   commander program assembly (+ global options)
    shared.ts    option parsers, filter parser, global-option resolver, JSON renderer
    io.ts        injectable IO + deps seam
    commands/
      entities.ts  list / get / count / entities
  index.ts       library root re-export
test/            node:test suites (no network in unit tests; a local server in http.test)
openapi.yaml     full OpenAPI 3.0.3 description of the upstream API
```

## The client is generic

The upstream API is uniform: one `{ meta, data }` envelope, every entity
collection supporting list + detail with the same `range_*` / `sort_*` / field
filter parameters. So the client exposes `list(collection, params)`,
`get(collection, id)` and `count(collection, params)` rather than 18
near-identical method pairs. The authoritative collection list is
`ENTITY_COLLECTIONS` in `client/types.ts`; the CLI validates the `<entity>`
argument against it.

## Scripts

```bash
npm run build       # tsc → dist/
npm test            # build, then run node:test suites against dist/
npm run typecheck   # tsc --noEmit
npm run docs        # typedoc → out/
npm start -- --help # run the CLI from source build
```

## Tests

- **Unit tests** inject a mock transport (`test/helpers.ts`) — no network.
- **`http.test.ts`** exercises the real transport against an ephemeral local
  `http.createServer` (redirects, JSON parsing, protocol guard).
- **`cli.test.ts`** drives `run()` with a stub client and capturing IO, asserting
  on output and exit codes.

## Notes from the live API (2026-06)

- `range_end` is a **page size**, not an absolute index. The API honours it up to
  **1000**; a value above 1000 is ignored and it falls back to the default of 100.
- A **missing id returns HTTP 500** (not 404), with the reason in
  `meta.status_message`; an invalid filter operator also returns 500.
- Filter operators: `eq, ne, gt, gte, lt, lte, cn, sw` (`in`, `ct` are rejected).
- `firstPublicationDate`-style timestamps and most fields are nullable — see
  `openapi.yaml`, which was reconstructed by probing the live API.

## Networking policy (engine.ts)

- **Redirects are followed** (up to `maxRedirects`, default **5**). abgeordnetenwatch
  301-redirects a collection path without its trailing slash (`/api/v2` ->
  `/api/v2/`), so following them is required for the client to work. A 3xx with no
  usable `Location`, or one past the limit, surfaces as an `AwApiError`.
- **Credential headers are stripped on a cross-origin redirect.** If a redirect
  target's host differs from the current one, `Authorization`, `Cookie` and
  `X-API-Key` are dropped before the next hop, so they never leak to an arbitrary
  host named in `Location`. (This API needs no auth, but the guard is unconditional.)
- **Transient `429`/`503` are retried** up to `maxRetries` (default 2). The retry
  delay honours a `Retry-After` header (delta-seconds or HTTP-date), clamped to 30s;
  absent or unparseable, it falls back to linear backoff (`retryDelayMs * attempt`).
- **Only `http:`/`https:` base URLs are accepted** — the scheme is validated in the
  engine constructor, and again per-request in the transport.
