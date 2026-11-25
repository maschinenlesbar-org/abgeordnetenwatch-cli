# abgeordnetenwatch-mcp

An [MCP](https://modelcontextprotocol.io/) server for the open
[abgeordnetenwatch.de](https://www.abgeordnetenwatch.de/api) parliamentary data API: German
politicians in the Bundestag, the 16 Landtage and the EU Parliament, their roll-call votes, side
jobs and committees, as tools for AI agents. Read-only, no API key, public data (CC0 1.0).

It is the MCP side of [abgeordnetenwatch-cli](https://github.com/maschinenlesbar-org/abgeordnetenwatch-cli),
built on the same typed client, and released with it.

## Install

```bash
npm i -g @maschinenlesbar.org/abgeordnetenwatch-mcp
```

This installs the **`abgeordnetenwatch-mcp`** command (Node.js 22.12+). Or run the container
image, for linux/amd64 and linux/arm64, which needs no Node.js:

```bash
docker run -i --rm ghcr.io/maschinenlesbar-org/abgeordnetenwatch-mcp:latest
```

## Connect a client

The server speaks MCP on stdio by default.

**Claude Code**

```bash
claude mcp add abgeordnetenwatch -- abgeordnetenwatch-mcp
# or with the image:
claude mcp add abgeordnetenwatch -- docker run -i --rm ghcr.io/maschinenlesbar-org/abgeordnetenwatch-mcp:latest
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{ "mcpServers": { "abgeordnetenwatch": { "command": "abgeordnetenwatch-mcp" } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "abgeordnetenwatch": { "type": "stdio", "command": "abgeordnetenwatch-mcp" } } }
```

**Over HTTP** (Streamable HTTP, one endpoint `POST /mcp`):

```bash
abgeordnetenwatch-mcp --transport http            # http://127.0.0.1:3000/mcp
claude mcp add --transport http abgeordnetenwatch http://127.0.0.1:3000/mcp
```

In a container, publish the port on loopback only:
`docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/maschinenlesbar-org/abgeordnetenwatch-mcp:latest --transport http --host 0.0.0.0 --allowed-hosts localhost,127.0.0.1`.

For scripts and shared configs, pin a release and its digest from the
[release notes](https://github.com/maschinenlesbar-org/abgeordnetenwatch-cli/releases) instead of
`latest`: `…/abgeordnetenwatch-mcp:<version>@sha256:<digest>`. Check an image's provenance with
`gh attestation verify oci://ghcr.io/maschinenlesbar-org/abgeordnetenwatch-mcp:<version> --repo maschinenlesbar-org/abgeordnetenwatch-cli`.

## Tools

| Tool | What it answers |
|---|---|
| `findPolitician` | Politicians by name, with the full match count (a full page is not all matches). |
| `getVotingRecord` | A politician's roll-call votes in one mandate: yes/no/abstain/no_show and the recent votes. |
| `findPolls` | The roll-call votes of a parliament period, newest first, by topic or dates. |
| `getPollResult` | How a vote went, in all and fraction by fraction. |
| `getSideJobs` | Declared side jobs and income of a politician's mandate, as declared (a band is not an amount). |
| `listEntities` | Any collection with filters, sorting and paging. |
| `getEntity` | One record with all its fields. |
| `countEntities` | How many records match. |

Every tool only reads. An answer is JSON (`structuredContent` and the same as text), with the
`source` it came from (the request a reader can follow to the record, e.g.
`…/api/v2/votes?mandate=200` for a voting record or `…/politicians?last_name%5Bcn%5D=Scholz` for an
ambiguous name; whole, never cut like the data; an answer a redirect fetched from another host says so there: "… (answered
by https://other.example after a redirect)", and a WARN record names both) and the data licence.
A text over 2000 characters is cut and ends in `…[cut, N characters in all]`, and the answer says
`truncated`. An answer over `--max-result-chars` first loses entries from the end of its page
(then `nextOffset` says where to go on), then has its longest texts cut further (each with that
mark) or, when that isn't enough, its other lists shortened (`reason` names them); a list keeps its
first entry, `notes` stay whole (as do the lists a tool keeps whole, a part of which would be wrong data), and the answer says `truncated`. One that can't be cut down so far is a tool error that says
to ask for less. An answer from the source over 16 MiB, the most the server reads, is a tool error that says so: narrower
options don't make it smaller. A failure is a tool error that says what to change (one over 5000 characters loses
its middle, never its end, where the reason is).

## Options

```
--transport <stdio|http>   stdio (default), or Streamable HTTP on POST /mcp
--host <address>           HTTP: the address to listen on (default 127.0.0.1)
--port <n>                 HTTP: the port (default 3000)
--allowed-hosts <list>     HTTP: Host header names to answer (default localhost,127.0.0.1,[::1])
--allowed-origins <list>   HTTP: browser origins allowed to call, exactly (https://app.example.org); none by default
--auth-token-file <path>   HTTP: a file with the bearer token every request must send (mode 600, 32+ characters)
--base-url <url>           API base URL (default https://www.abgeordnetenwatch.de)
--timeout <ms>             per upstream request (default 30000)
--call-timeout <ms>        per tool call, retries included (default 45000)
--max-result-chars <n>     cap on one tool result's JSON (default 25000)
--max-pages <n>            pages of 1000 read per collection and call (default 10)
--user-agent <ua>          User-Agent header value (Latin-1, one line)
--log-format <text|jsonl>  the log records on stderr (default text)
```

## What it does and doesn't do

- **Read-only.** No tool changes anything, here or upstream.
- **No authentication** on HTTP unless you give one. It listens on loopback by default; it checks
  the `Host` header and, from a browser, the `Origin` (only the origins given with
  `--allowed-origins`, matched exactly) against DNS rebinding and other web pages; a page on one
  of those origins gets CORS (its preflight answered, the answers readable). With
  `--auth-token-file <path>` every request must send `Authorization: Bearer <token>` (the file holds
  one token of at least 32 characters, mode 600, owned by the user the server runs as, a regular
  file (a FIFO is refused at once, never waited on); read once at start; `(umask 077; openssl rand -hex 32 > mcp-token)` makes one); anything else is answered 401.
  Exposed beyond localhost (it logs a warning then), it belongs behind a proxy that authenticates or
  at least terminates TLS.
- **Gentle with the upstream.** One server process sends at most 2 requests at a time and 120 a
  minute to abgeordnetenwatch.de, pauses the requests to a host that answers HTTP 429 (as long as
  its Retry-After asks, at most 30 s; those to another host go on), and stops a tool call after its deadline (a tool that has read part of its answer by then
  may answer with that part, and says so). A request those limits would hold longer than it or
  its call may wait is not sent: the call fails at once, naming the limit and when to ask again
  (and the log says so).
- **Results are data.** Text from the API, keys included, is cleaned (control, bidi,
  zero-width, tag and other invisible characters removed, but an emoji keeps its joiners; a key that cleaning makes equal to another stays, as `name~2`),
  but it is still other people's text: a model can be told things in it. The server
  can't act on that (it has no tool that writes), but other tools in the same session could.
- **Stops cleanly.** On `docker stop` (SIGTERM) or Ctrl-C the HTTP server takes no new
  connection and lets calls in flight answer for up to 5 s, then exits 143 (130); a second signal
  ends it at once. On stdio a signal ends it at once; when stdin ends, it first answers the
  requests it has read (each within its call deadline), then exits.
- **Logs** go to stderr, one record per line; stdout carries only the protocol. A call that fails
  upstream or reaches its deadline leaves a WARN record naming the tool.
- **Never installs anything** and needs no key.

## Licence

Code: AGPL-3.0-or-later or commercial
([LICENSING.md](https://github.com/maschinenlesbar-org/abgeordnetenwatch-cli/blob/main/LICENSING.md)).
Data: abgeordnetenwatch.de publishes it under CC0 1.0
([DATA_LICENSE.md](https://github.com/maschinenlesbar-org/abgeordnetenwatch-cli/blob/main/DATA_LICENSE.md)).
