# abgeordnetenwatch-cli

Query Germany's **parliamentary-monitoring data** — politicians, mandates,
votes, committees and disclosed side jobs — from your terminal.
`abgeordnetenwatch` is a command-line tool and TypeScript client for the open
[abgeordnetenwatch.de API v2](https://www.abgeordnetenwatch.de/api): list any of
18 entity collections, filter and sort them, fetch single records, count
matches, and pipe the JSON straight into [`jq`](https://jqlang.github.io/jq/).

- **Works out of the box** — no account, no API key, no configuration.
- **Clean JSON output** — pretty-printed by default, `--compact` for scripting.
- **Four commands** — `list`, `get`, `count`, `entities`.
- **Read-only, open data** — the public API needs no credentials, and the data
  is **CC0 1.0** (public domain); see [DATA_LICENSE.md](DATA_LICENSE.md).

> Want to use this as a TypeScript library or understand how it's built?
> See **[DEVELOPING.md](DEVELOPING.md)**. The full API reference lives in
> **[openapi.yaml](openapi.yaml)**.

## Install

```bash
npm i -g @maschinenlesbar.org/abgeordnetenwatch-cli
```

This installs the **`abgeordnetenwatch`** command. Requires **Node.js 20+**.

```bash
abgeordnetenwatch --help
abgeordnetenwatch entities          # the 18 collections you can query
```

## Quickstart

```bash
# How many female politicians are in the database?
abgeordnetenwatch count politicians sex=f

# Five politicians born after 1990, sorted by surname
abgeordnetenwatch list politicians 'year_of_birth[gt]=1990' \
  --sort-by last_name --range-end 5 --data-only

# Fetch one party
abgeordnetenwatch get parties 2 --data-only

# Every individual vote in poll 6569 (the data array only)
abgeordnetenwatch list votes poll=6569 --data-only | jq '.[].vote' | sort | uniq -c
```

## Commands

| Command | What it does |
|---|---|
| `list <entity> [filters...]` | List a collection, with optional filters, `--sort-by`/`--sort-direction`, and `--range-start`/`--range-end` paging. |
| `get <entity> <id>` | Fetch a single entity by id. |
| `count <entity> [filters...]` | Print `{ entity, total }` — the number of matches. |
| `entities` | List the 18 available entity collections. |

`--data-only` (on `list`/`get`) prints just the `data` payload instead of the
full `{ meta, data }` envelope.

### Filtering

Add filters as `key=value` arguments after the entity:

- **Equality:** `sex=f`, `year_of_birth=1980`
- **Related entity by id:** `politician=184945`, `poll=6569`
- **Comparison operators** — `field[op]=value` with `op` one of
  `eq, ne, gt, gte, lt, lte, cn` (contains), `sw` (starts-with):
  `'year_of_birth[gt]=1990'`, `'last_name[sw]=Mü'`

  (Quote any filter containing `[ ]` so your shell doesn't glob it.)

### Paging

`--range-end` is the **page size** (number of items). The API honours it up to
**1000**; a value above 1000 is ignored and the API falls back to its default
page size of 100. Use `--range-start` to offset into the next page; `count`
reports the true total.

## Entities

`parliaments`, `parliament-periods`, `politicians`, `candidacies-mandates`,
`committees`, `committee-memberships`, `polls`, `votes`, `parties`, `fractions`,
`election-program`, `electoral-lists`, `constituencies`, `sidejobs`,
`sidejob-organizations`, `topics`, `cities`, `countries`.

See [openapi.yaml](openapi.yaml) for every field of every entity.

## Global options

`--base-url <url>`, `--timeout <ms>`, `--user-agent <ua>`,
`--max-retries <n>` (transient 429/503), `--max-response-bytes <n>`, `--compact`.

The service rate-limits bursts with HTTP `429`; the client retries these
automatically. Sending a descriptive `--user-agent` is appreciated by the
provider.

## Exit codes

`0` success · `1` runtime/network/server error · `2` usage error (unknown
entity, bad option/filter) · `4` HTTP 404 (unknown collection path).

> Note: the API returns HTTP **500** (not 404) for a missing id; the CLI surfaces
> the reason from `meta.status_message` and exits `1`.

## License

Code: [AGPL-3.0-or-later](LICENSE) or a [commercial license](LICENSING.md).
Data: **CC0 1.0** by abgeordnetenwatch.de — see [DATA_LICENSE.md](DATA_LICENSE.md).
