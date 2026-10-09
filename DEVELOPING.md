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
    errors.ts    AwError / AwApiError / AwNetworkError / AwParseError / AwValidationError
    validate.ts  Problem rules + assertValid (input checks shared with the CLI)
    types.ts     envelope + entity types, the ENTITY_COLLECTIONS list
    client.ts    AbgeordnetenwatchClient — generic list/get/count over a collection
    index.ts     public library surface
  cli/
    index.ts     #! bin shim → run()
    run.ts       argv → exit code, error→exit-code mapping
    program.ts   commander program assembly (+ global options)
    shared.ts    option parsers, filter parser, global-option resolver, JSON renderer
    io.ts        injectable IO + deps seam, the logger and the clock
    log.ts       the stderr log: records with ts, level, topic; --log-format text|jsonl
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

## Input validation

The library owns every rule about what a request may contain, and checks it before
sending anything. A rule is a pure `Problem` function in `client/validate.ts` (or next
to the parameter it checks): it returns the reason a value is invalid, or `undefined`.
Client methods enforce it with `assertValid(name, value, problem)`, which throws
`AwValidationError` (a subclass of `AwError`) with the message `Invalid <name>: <reason>`;
methods that return a promise reject with it, and no request is sent. The CLI's
commander parsers call the same functions and turn the reason into a usage error, and
`run.ts` maps an `AwValidationError` raised inside an action to exit 2 as well, logged as
an `ERROR` record of `abgeordnetenwatch.cli`. So the CLI and the library reject the same inputs, and
`test/helpers.ts`'s `parity()` checks that: it runs one input through `run()` and through
the library on one recording mock transport and returns both outcomes.

What the library rejects with `AwValidationError`:

- **Arguments of the wrong type**: a collection outside `ENTITY_COLLECTIONS` (`list`,
  `get`, `count`), a `params` that is not an object (`assertParams`; `count("parties",
  5)` used to send a request) and `filters` that are not an object.
- **Entity ids** (`get`): anything but a positive integer, as a number or a string of
  ASCII digits (`entityIdProblem`). `0` and `""` would fetch the whole collection, and
  `" 2 "`, `"abc"`, `-1` or `1.5` a generic HTTP 500. `normalizeEntityId` drops leading
  zeros, because the API looks the id up as a string (`0002` was "no such entity").
- **Filters** (`list`, `count`; `client/filters.ts`, `validateFilters`): a blank key or
  value, a key that is not a field name with at most one bracket operator (`FILTER_KEY`),
  an operator outside `FILTER_OPERATORS`, a paging or sorting name
  (`RESERVED_FILTER_FIELDS`: `range_start`, `range_end`, `sort_by`, `sort_direction`)
  and a plain key next to a bracket key on the same field. The API drops such a filter
  silently and returns the unfiltered (or partly filtered) set as a success. Also the
  names `__proto__`, `constructor` and `prototype` (`FORBIDDEN_FILTER_FIELDS`; assigning
  `__proto__` to a plain object set the prototype, so the filter vanished from the
  request), and a value that is not one string, finite number or boolean
  (`filterValueProblem`: an array went out as repeated keys, of which the API keeps
  one, `NaN` and objects as text). An ordinary unknown field is sent: the API rejects it
  itself with HTTP 500 ("The following parameter(s) are not valid: …").
- **Parameter keys** (`list`, `count`; `assertKnownListParams`): a key outside
  `LIST_PARAM_KEYS` (`filters`, `rangeStart`, `rangeEnd`, `sortBy`, `sortDirection`). A
  misspelled `filter` or a wire name such as `range_end` used to be ignored. The CLI makes
  a repeated single-value option a usage error (`forbidRepeatedOptions`). The CLI
  keeps only what argv needs on top: the split at the first `=` and the check for an
  exact repeated key.
- **Paging and sorting** (`list`, `count`; `validateListParams`): `rangeStart` and
  `rangeEnd` that are not non-negative safe integers (`rangeProblem`), a blank `sortBy`
  (`nonBlankProblem`), a `sortDirection` other than `asc`/`desc` (`SORT_DIRECTIONS`,
  `sortDirectionProblem`) and a `sortDirection` without `sortBy` (`sortPairProblem`; the
  API answers it with HTTP 500). The CLI keeps the argv-to-number parsing
  (`parseIntArg`) and words the pair rule with its flag names.
- **Header values** (constructor; `headerValueProblem`, `headerNameProblem`): a
  `userAgent` or `headers` value that is blank, contains a control character other than
  tab (CR/LF would inject a header), DEL or a character above U+00FF, and a `headers`
  name that is not an HTTP token. Only an absent `userAgent` selects the default
  `abgeordnetenwatch-cli`. The default transport also turns any header Node refuses into
  an `AwNetworkError` instead of a raw `TypeError`.
- **Base URL** (constructor; `baseUrlProblem`): anything but an absolute `http:`/`https:`
  URL, one with a query or fragment, one with surrounding whitespace and one whose user
  name or password has a `%` that doesn't start an escape (write a literal `%` as `%25`;
  the engine percent-decodes the userinfo for the Authorization header). All of them are
  configuration errors, so the class is `AwValidationError`, never `AwNetworkError`
  (which a caller may retry as transient). See the networking policy below.

## Scripts

Node.js 22.12 or later (`engines`; commander 15 needs it). CI (`ci.yml`) type-checks, builds
and tests on Node 22/24.

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
- **`log.test.ts`** tests the record helpers of `src/cli/log.ts` on their own
  (`escapeForRecord`, `formatLogRecord`); the CLI-level checks are P23's.
- **`conformance-p*.test.ts`** are the shared checks of the 2026-10-05 fix plan, the
  same files in every maschinenlesbar.org CLI with only an adapter block at the top:
  P1 CLI redaction, P2 library redaction, P3 redirect credentials, P4 base-URL
  validation (its P19 case is skipped: this CLI reads no environment variable), P5 the
  transport contract, P6 the retry policy, P7 pipes and exit codes (runs the built bin),
  P8/P9/P13 charset, envelopes and error classes, P10 strict filters and parameters,
  P20 the stderr warning for a plain-`http:` base URL (its env-variable and other-secret
  cases are skipped: this CLI reads no environment variable and sends no key), P21 the
  README's relative links (README.md ships to npmjs.com, so a link to a document the
  `files` allowlist leaves out must be an absolute GitHub URL), P23 the log records on
  stderr and `--log-format`.
  They use mock transports or local servers only, never the live API.

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
  `/api/v2/`), so following them is required for the client to work. Only 301, 302,
  303, 307 and 308 are followed. Any other 3xx (300, 304, 305), one with a missing or
  malformed `Location`, and one past the limit surface as an `AwApiError` whose
  message and `location` field name the target:
  `HTTP 302 for GET <url>: redirect to <target> not followed` (or
  `redirect not followed (no Location header)`).
- **Caller headers are stripped on a cross-origin redirect.** If a redirect
  target's origin (scheme + host + port) differs from the current one —
  including a same-host `https:` -> `http:` downgrade — every header passed in
  `headers` is dropped before the next hop; only the engine's own `Accept` and
  `User-Agent` go along. So no credential (`Authorization`, `Proxy-Authorization`,
  `Cookie`, `X-API-Key`, `X-Auth-Token`, ...) leaks to an arbitrary host named in
  `Location`, nor crosses the wire in cleartext. (This API needs no auth; the guard
  matters for headers added for a proxy or mirror.) It holds as long as the transport
  leaves redirects to the engine: every request carries `redirect: "manual"`
  (`HttpRequest.redirect`, which a fetch transport passes on), and a response whose
  `HttpResponse.url` lies on another origin (a transport that followed a redirect
  itself) is rejected as an `AwNetworkError`. A custom transport that follows
  redirects silently and doesn't report `url` is outside the engine's reach.
- **Base-URL credentials go to their own origin only.** The userinfo of a base URL
  (`https://user:pw@mirror/`) never reaches the transport in the URL: the engine sends
  it as an `Authorization: Basic` header per hop (a caller's own `Authorization` header
  wins). A redirect to the same origin, with a relative or an absolute `Location`, keeps
  it; one that crosses an origin boundary drops it, and a `401`/`403` from the target
  then says so ("the server redirected http→https, which dropped the credentials; use an
  https base URL"). Userinfo in a `Location` is never used.
- **Transient `429`/`503` are retried** up to `maxRetries` (default 2; the CLI's
  `--max-retries` accepts 0..10). Each retry waits the linear backoff
  (`retryDelayMs * attempt`, default 1 s then 2 s), or a `Retry-After` header
  (delta-seconds or an IMF-fixdate HTTP-date, parsed strictly by the exported
  `parseRetryAfter`) when that is longer: the header can lengthen a wait, never shorten
  it, so `Retry-After: 0` or a past date can't turn the retries into a burst. A
  `Retry-After` above `MAX_RETRY_AFTER_MS` (30 s) is not retried at all: the error
  surfaces at once, names the requested wait (`the server asked to retry after 120 s,
  longer than the 30 s the client waits; not retried`) and carries it as
  `AwApiError.retryAfterMs`, and the CLI's hint says to wait that long instead of
  pointing at `--max-retries`. After spent retries the message ends `(after N retries)`
  (`AwApiError.retries`). A malformed `Retry-After` (`-1`, `1.5`, other date formats)
  is ignored. The live API answers a burst with `429` and no `Retry-After`
  for about 1–2 s, so a shorter default (it was 200 ms) failed back-to-back runs. A GET
  whose connection was reset (`ECONNRESET`, `EPIPE`, `ECONNABORTED`, undici's
  `UND_ERR_SOCKET`, anywhere in the error's `cause` chain; `isTransientNetworkError`) is
  retried the same number of times, after `retryDelayMs * attempt`; a refused
  connection, a DNS failure or a timeout is not.
- **The transport contract is enforced by the engine.** `timeoutMs` and
  `maxResponseBytes` hold for every transport, not only the built-in one: the engine
  runs each transport call under the overall deadline (it passes an `AbortSignal` in
  `HttpRequest.signal`, which the built-in transport honours and a fetch transport
  should pass on, and rejects at the deadline either way) and checks the size of the
  body it gets back (the message names `maxResponseBytes` and `--max-response-bytes`).
  Response headers are read in any case and from a `Headers` object or a `Map` too, so
  `Retry-After`, `Location` and `Content-Type` work with a fetch transport; the body may
  be a `Buffer`, any `ArrayBuffer` view (fetch's `Uint8Array`) or an `ArrayBuffer`.
  Whatever a transport throws, and a response without a valid status, headers object
  or body, becomes an `AwNetworkError`. A redirect to a scheme other than
  `http:`/`https:` is refused before the transport is called.
- **Numeric engine options are validated.** `timeoutMs` (0..2^31-1), `maxRetries`
  (0..`MAX_RETRIES`, 10), `retryDelayMs` (0..30 000), `maxRedirects` (0..20) and
  `maxResponseBytes` (0..`Number.MAX_SAFE_INTEGER`) must be integers in range; anything
  else throws `AwValidationError` (`Invalid option timeoutMs: expected an integer from 0
  to ...`) at construction, instead of a negative or NaN value silently disabling a
  limit. So does an options value that is not an object, a `transport` or `sleep` that
  is not a function, and `headers` that are not a plain object.
- **Server text in messages is cut.** An API error's `detail` (`meta.status_message`,
  `detail` or `message` of the body) is cut at 500 characters (`MAX_MESSAGE_TEXT`,
  `cutForMessage`, which counts code points) in the message; `AwApiError.body` keeps the
  whole body. A long URL in a message is cut in the middle, never inside a surrogate pair
  (`cutText`), so the message stays well-formed. Any other value an own message quotes
  from a server answer or the user's input (a redirect target, a Content-Type or charset,
  an id, an entity name, a filter key, operator or value, a parameter name) is cut at
  `MAX_QUOTED_LENGTH` (200, `cutForMessage`; `quoteValue` redacts a value's userinfo
  before the cut), so `err.message` stays bounded for a library caller. `cutForMessage`
  and `MAX_MESSAGE_TEXT` live in `errors.ts` and are re-exported from `engine.ts`.
- **Only `http:`/`https:` base URLs are accepted** — one rule, `baseUrlProblem`, checked
  by `--base-url` at parse time (a usage error) and by the engine constructor on the raw
  value, before it strips trailing slashes (the exported `assertValidBaseUrl`); the
  transport re-checks the scheme per request. A base URL with a query (`?`) or fragment
  (`#`) is rejected too, because paths are appended to it as a string and either would
  swallow every request path, and so is one with surrounding whitespace, which
  `new URL()` would trim silently while the engine kept the raw string (`"https://h/ "`
  requested `/%20/api/v2/...`). A `%` in the userinfo that isn't an escape
  (`http://alice:100%@mirror`) is rejected the same way, as a usage error before any
  request, instead of a raw `URIError` when the Authorization header is built.
- **Plain `http:` gets a warning, not a refusal.** `cleartextProblem(baseUrl, secrets)`
  (engine, exported) returns one sentence naming the host (`url.host`, never the userinfo)
  and what travels unencrypted — the base URL's credentials when it carries userinfo — or
  `undefined` for `https:`, an unparseable URL and loopback hosts (`localhost`,
  `127.0.0.0/8`, `::1`). The CLI's `action()` wrapper (`shared.ts`, `warnOnCleartext`)
  logs it once per run as a `WARN` record of `abgeordnetenwatch.http` on stderr, after the options are parsed
  and before the first request; `--help`, `--version` and usage errors never get there.

- **Credentials never reach output.** Userinfo in the base URL
  (`https://user:secret@mirror/`) is allowed, but `redactUrl` (exported from
  [`errors.ts`](src/client/errors.ts)) shows it as `***@` in every error message and in
  `AwApiError.url`, and library messages quote a rejected value through it. The CLI also
  redacts on output: `run.ts` (`redactionFor`, `withRedactedOutput`) takes the exact
  userinfo of every URL argument (`credentialsIn`, exported) and replaces it with `***` in
  everything it prints — commander's usage errors, which echo rejected values, an unknown
  command, a stray argument — so a password with spaces, quotes, `#`, `?` or `/` is caught
  as well as an ordinary one. Only a value that starts with a scheme counts (a bare `a:b@c`
  is a filter value, a search text or a User-Agent as often as a credential), except as
  the `--base-url` value, where a `user:password@host` typed without its scheme is still a
  credential. The log replaces it in each record's *message*, before the record is cut and
  escaped, and writes to the raw stderr: the frame (time, level, topic) is never touched,
  and a password with DEL, C1 or bidi characters is matched in its raw form. `redactUrl` falls back to the same text-based cut (`redactCredentials`,
  exported) for a value that doesn't parse as a URL. The engine keeps the base URL and
  the caller's `headers` in real `#private` fields, so `console.log(client)`,
  `util.inspect` and `JSON.stringify` never show them, and it scrubs the base URL's
  userinfo (raw and percent-decoded), and the forms a server echoes it back in (the
  `Basic` value, the decoded `user:password`, the password alone from 4 characters:
  `echoedCredentialForms`), from error bodies and details, a redirect `Location`, a
  custom transport's error text and the `cause` chain. The CLI replaces the same forms:
  the `Basic` value and the pair on stdout and stderr, the password alone on stderr only,
  since it may well occur in the data. Whatever a custom transport
  throws reaches the caller as an `AwNetworkError` (`GET <url> failed: <reason>`, the
  original as `cause`).

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

## The log on stderr

Every diagnostic line on stderr is a log record (`src/cli/log.ts`): a timestamp, a level
(`ERROR`, `WARN`, `INFO`) and a topic, `abgeordnetenwatch.<area>`. `--log-format text` (the
default) writes it log4j style, `<ISO 8601 UTC> <LEVEL padded to 5> [<topic>] <message>`;
`--log-format jsonl` writes one JSON object per line with exactly `ts`, `level`, `topic`
and `msg`. A record is always one line: `formatLogRecord` runs `escapeForRecord` over
the message (text) or the whole JSON object (jsonl), which writes CR and LF as `\r`/`\n`,
every other C0 control but TAB, DEL and C1 as `\u00XX`, and U+2028, U+2029 and the bidi
controls as `\uXXXX`, so no text that reaches a record, by whatever path, can split it,
forge another one or steer the terminal. Before that a lone surrogate (half a
character, which jq rejects, stopping the whole stream) becomes U+FFFD (`toWellFormed`),
and a message longer than `MAX_RECORD_MESSAGE` (4000 characters, exported) is cut at a
code point and ends in `… (N more characters)`. The areas are `cli` (usage errors, commander's messages, unexpected errors),
`api` (the API's error answers, and the hints after them as `INFO`), `http` (the
connection, the cleartext warning) and `output` (a failed write to stdout). Code logs through `logOf(deps)` and never writes
diagnostics with `io.err` directly. `run()` builds the logger from argv before commander
parses it (`logFormatFromArgv`, used only for the records of a parse error: the first
`--log-format` counts, and the value of an option that takes one is skipped, as commander
reads it; a `preAction` hook then sets the format commander parsed, so
`--user-agent --log-format=jsonl` logs text), so commander's own usage errors are records too: its `error: …` an ERROR of `cli` (a
`(Did you mean …?)` line joined to it), the help it shows after one an INFO record per
line, and the program run without a command (or `help <unknown name>`) an ERROR
"missing command: `abgeordnetenwatch <subcommand>`" before that help, so every failed run
has an ERROR record (`writeCommanderErr`). The log is built with the run's redaction
(`withRedactedOutput`), which replaces a secret in the message only, before it is
escaped: the frame is never touched, and a secret is kept out of the log in either format. `CliDeps.now` makes the
timestamps testable. stdout carries data only. A failed write to stdout other than a
closed pipe (`handleOutputErrors`, in the bin shim, outside `run()`) is an ERROR record of
`abgeordnetenwatch.output` (`Could not write to stdout: …`), in the format argv asks for
(`processLogger`). Conformance test P23 checks all of this, and its body
is shared across the *-cli repos.
