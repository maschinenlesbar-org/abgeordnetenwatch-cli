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

The client checks the envelope of every 2xx response: an object with a `meta`
object, `data` an array (`list`) or an object (`get`), and for `count` a
non-negative integer `meta.result.total`. Anything else raises `AwParseError`
(`Unexpected response shape from <path>: expected ...`). The records themselves
are passed through unchecked.

## Scripts

```bash
npm run build       # tsc → dist/
npm test            # build, then run node:test suites against dist/
npm run typecheck   # tsc --noEmit
npm run docs        # typedoc → out/ (first: npm ci --prefix tools/docs)
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
  target's origin (scheme + host + port) differs from the current one —
  including a same-host `https:` -> `http:` downgrade — `Authorization`, `Cookie`
  and `X-API-Key` are dropped before the next hop, so they never leak to an
  arbitrary host named in `Location`, nor cross the wire in cleartext. (This API
  needs no auth, but the guard is unconditional.)
- **Transient `429`/`503` are retried** up to `maxRetries` (default 2; the CLI's
  `--max-retries` accepts 0..10). The retry delay honours a `Retry-After` header
  (delta-seconds or an IMF-fixdate HTTP-date, parsed strictly by the exported
  `parseRetryAfter`); one above `MAX_RETRY_AFTER_MS` (30 s) is not retried at all, the
  error surfaces at once. Absent or malformed (`-1`, `1.5`, other date formats), it
  falls back to linear backoff (`retryDelayMs * attempt`,
  default 1 s then 2 s). The live API answers a burst with `429` and no `Retry-After`
  for about 1–2 s, so a shorter default (it was 200 ms) failed back-to-back runs.
- **Only `http:`/`https:` base URLs are accepted** — `--base-url` is checked at parse
  time (a usage error), then the scheme is validated again in the engine constructor
  and per-request in the transport. A base URL with a query (`?`) or fragment (`#`) is
  rejected too (at parse time, and by the engine for library users): paths are appended
  to it as a string, so either would swallow every request path.

## Website

The project website — <https://maschinenlesbar-org.github.io/abgeordnetenwatch-cli/> in English
and <https://maschinenlesbar-org.github.io/abgeordnetenwatch-cli/de/> in German — is built from
`site/` with [Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web
components and [Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the
TypeDoc API reference under `/api/`. Its content comes from this repository: the README intro
and quick start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`),
`Usage.md`, `GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill
examples in `EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are
`site/_config.yml` and `site/_data/project.yml` (the German intro and the access requirements);
the rest of `site/` is identical in every maschinenlesbar.org CLI, so change it in all of them
together. When the README intro changes, update the German intro in `site/_data/project.yml`.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/abgeordnetenwatch-cli/
```
