---
name: abgeordnetenwatch-voting-record
description: >
  Pull and summarise a German politician's roll-call voting record from the
  abgeordnetenwatch.de API, using the abgeordnetenwatch-cli. Trigger when the
  user asks "how did <MP> vote?", "voting record of <politician>", "how often
  did X vote with their party?", "show me <name>'s votes on <topic>", or wants
  an attendance / yes-no breakdown for a member of the Bundestag, EU Parliament
  or a Landtag.
version: 1.0.0
userInvocable: true
---

# Abgeordnetenwatch Voting Record

Turn a politician's name into a clean voting summary: how many recorded roll-call votes,
the yes / no / abstain / no-show breakdown, and the notable individual votes — for any
member of the Bundestag, the EU Parliament or a state parliament that abgeordnetenwatch
tracks.

## Tooling

This skill drives the `abgeordnetenwatch` command. **Before anything else, validate it is available** — run `command -v abgeordnetenwatch` (or `abgeordnetenwatch --help`). If it is not on your PATH, STOP and inform the user that the `abgeordnetenwatch` CLI (`@maschinenlesbar.org/abgeordnetenwatch-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

Data comes from the open abgeordnetenwatch.de API v2 — read-only, **no API key**, **CC0 1.0**. Always pass `--compact` and `--data-only` so you get a single-line JSON array ready for `jq`. An empty array is a valid answer (the person has no recorded votes).

## Step 1 — Resolve the politician

Find the person by surname (`[cn]` = contains, case-insensitive). Names are not unique —
**confirm the right row** by party and id before going on.

```bash
abgeordnetenwatch list politicians 'last_name[cn]=Scholz' --range-end 10 --data-only --compact \
  | jq -c '.[] | {id, label, party: .party.label, year_of_birth}'
```

> The query is matched against the database fields, not a search engine: use the **surname**
> (try `first_name`/`last_name` separately if needed). A common name returns many rows —
> disambiguate by `party.label` and `year_of_birth`, and if still ambiguous ask the user
> which one.

## Step 2 — Find the mandate(s)

Votes are attached to a **mandate** (a seat in a specific parliament period), not directly
to the politician. Resolve the politician id to their mandate id(s):

```bash
abgeordnetenwatch list candidacies-mandates politician=<POLITICIAN_ID> --data-only --compact \
  | jq -c '.[] | select(.type=="mandate") | {mandate_id: .id, label, period: .parliament_period.label}'
```

> A politician can have **several mandates** (e.g. successive legislative periods, or both a
> Bundestag and an EU seat). Pick the period the user means; default to the most recent. The
> `type` field is `mandate` for a held seat vs `candidacy` for a candidacy — vote records
> exist for **mandates**.

## Step 3 — Pull and tally the votes

Filter votes by the mandate id. The vote values are `yes`, `no`, `abstain`, `no_show`.

```bash
# total (cheap):
abgeordnetenwatch count votes mandate=<MANDATE_ID>
# the records (page at 100; loop --range-start for members with >100 votes):
abgeordnetenwatch list votes mandate=<MANDATE_ID> --range-end 100 --data-only --compact > /tmp/v.json
jq -c 'group_by(.vote) | map({ (.[0].vote): length }) | add' /tmp/v.json
```

> **Page size is capped at 100.** If `count` reports more than 100 votes, fetch successive
> pages with `--range-start 100`, `200`, … and concatenate before tallying — otherwise the
> breakdown silently covers only the first 100. `no_show` means the member did not
> participate (absent or did not vote); report it separately from `no`, not as a "no".

## Step 4 — Add context for notable votes

Each vote references its **poll** (the bill/motion). Join to the poll label to make the
record legible, and pull the fraction the member sat with:

```bash
jq -c '.[] | {vote, poll: .poll.label, fraction: .fraction.label}' /tmp/v.json | head
```

For "did they vote with their party?" compare the member's vote on a poll against their
fraction's majority (see **abgeordnetenwatch-poll-breakdown** for the per-fraction tally).

## Step 5 — Brief the user

```
Voting record — Olaf Scholz (SPD), Bundestag 2025–2029  ·  mandate 68873
57 recorded roll-call votes: 47 yes · 8 no · 2 no-show · 0 abstain
(no_show = did not participate)

Recent notable votes:
• yes — <poll label>
• no  — <poll label>
```

Rules:
- Lead with **who** (name, party, parliament period, mandate id) so the record is auditable.
- Give the **yes / no / abstain / no_show** counts; never fold `no_show` into `no`.
- Only roll-call (namentliche) votes are in this data — most parliamentary votes are *not*
  recorded by name, so this is a sample of decisions, not every vote. Say so.
- If a member has multiple mandates, state which one you summarised and offer the others.
- Cite the politician id and mandate id; offer the abgeordnetenwatch profile URL
  (`abgeordnetenwatch_url` on the politician record).
