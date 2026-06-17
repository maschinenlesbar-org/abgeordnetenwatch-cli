# abgeordnetenwatch-cli — Claude Code Skills

A set of [Claude Code](https://code.claude.com/docs/en/skills) **Agent Skills** for German
parliamentary-data intelligence, all powered by the **[abgeordnetenwatch](README.md)** CLI
over the open [abgeordnetenwatch.de API v2](https://www.abgeordnetenwatch.de/api) — the
citizen-facing monitoring platform for the Bundestag, the EU Parliament and the 16 state
parliaments. The data is **CC0 1.0** (public domain).

Each skill teaches Claude how to drive the `abgeordnetenwatch` CLI to answer a specific,
real-world question — "how did this MP vote?", "what side income did they disclose?", "how
did the fractions split on this bill?" — and to report it with evidence and the right
caveats. The bare CLI returns raw register entries; the skills do the multi-step joins
(politician → mandate → votes/side jobs), the aggregation, and the parts that are easy to
get wrong (the 100-item page cap, the `mandates` filter name, the German-only / German-MEPs
scope notes).

## Skills

| Skill | What it does | Ask it… |
|---|---|---|
| **abgeordnetenwatch-voting-record** | Resolves a politician → mandate → roll-call votes and summarises the yes/no/abstain/no-show breakdown with notable votes. | "how did Scholz vote?", "voting record of <MP>", "how often did X vote with their party?" |
| **abgeordnetenwatch-sidejobs** | Surfaces a member's disclosed side income (Nebentätigkeiten) — job, paying organisation, and declared amount or band. | "what side jobs does <MP> have?", "who pays <politician>?", "Nebeneinkünfte von <name>" |
| **abgeordnetenwatch-poll-breakdown** | Takes a named roll-call vote and shows how each fraction voted, with the overall result. | "how did the Bundestag vote on <bill>?", "which parties backed <motion>?", "roll-call result for <poll>" |

## Requirements

- **[Claude Code](https://code.claude.com/docs/en/overview)** (or any harness that loads
  Agent Skills).
- **The `abgeordnetenwatch` CLI** installed globally:
  ```bash
  npm i -g @maschinenlesbar.org/abgeordnetenwatch-cli   # installs the `abgeordnetenwatch` bin
  ```
  No API key is required — the API is free, open, read-only, and CC0-licensed.

## Installation

### Plugin marketplace (recommended)

This repo is a Claude Code **plugin marketplace**:

```
/plugin marketplace add maschinenlesbar-org/abgeordnetenwatch-cli
/plugin install abgeordnetenwatch@abgeordnetenwatch-skills
```

The first command registers the marketplace; the second installs the `abgeordnetenwatch`
plugin, which bundles all three skills. Update later with `/plugin marketplace update`.

### Manual (copy the skill folders)

```bash
git clone https://github.com/maschinenlesbar-org/abgeordnetenwatch-cli tmp-skills
mkdir -p ~/.claude/skills
cp -R tmp-skills/skills/* ~/.claude/skills/
rm -rf tmp-skills
```

…or into a single project's `.claude/skills/`. Each skill lives in its own directory with a
`SKILL.md`, e.g. `skills/abgeordnetenwatch-voting-record/SKILL.md`. Start a new session and
the skills are picked up automatically.

## Usage

You don't normally invoke these by name — Claude auto-selects the right skill from your
request. Just ask in natural language:

> How did Olaf Scholz vote in the current Bundestag, and did he ever break with his party?

> What side jobs has my MP disclosed, and who pays them?

> Break down the last EU-Parliament roll-call on the US trade deal by fraction.

## How it works

Every skill is a single `SKILL.md` — a short, model-facing playbook describing which
`abgeordnetenwatch` subcommands to call (`list`, `get`, `count`, `entities`), how to join the
entities, and how to interpret the result. The skills encode the non-obvious parts of this
API, for example:

- **votes and side jobs hang off a *mandate*, not the politician** — resolve
  `politicians` → `candidacies-mandates` (`politician=<id>`) → the mandate id, then filter
  `votes` (`mandate=<id>`) or `sidejobs` (`mandates=<id>`);
- **the side-jobs filter is `mandates` (plural)** — the field name on the record;
  `mandate=`/`politician=` are rejected with HTTP 500;
- **the page size is capped at 100** — `count` gives the true total, but the records must be
  paged with `--range-start` 0, 100, 200, … before tallying, or a ~700-vote Bundestag poll
  silently reports only its first 100 votes;
- **`no_show` is non-participation**, reported separately from `no`;
- **EU-Parliament polls record only the German MEPs' votes** — a scope note to surface so the
  per-fraction totals aren't misread as the whole 720-seat house.

See [openapi.yaml](openapi.yaml) for the full field reference of all 18 entity collections.

## Contributing

This project does not accept external code contributions (see
[CONTRIBUTING.md](CONTRIBUTING.md)). When adding a skill internally, keep `SKILL.md` focused,
give it a `description` with concrete trigger phrases, and follow the
[official skill format](https://code.claude.com/docs/en/skills).

## License

Code: [AGPL-3.0-or-later](LICENSE) © Sebastian Schürmann — see [LICENSING.md](LICENSING.md)
for the dual-licensing / commercial option. Data: **CC0 1.0** by abgeordnetenwatch.de — see
[DATA_LICENSE.md](DATA_LICENSE.md).
