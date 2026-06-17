---
name: abgeordnetenwatch-poll-breakdown
description: >
  Break down how a parliament voted on a specific roll-call vote (namentliche
  Abstimmung) — fraction by fraction — from the abgeordnetenwatch.de API, using
  the abgeordnetenwatch-cli. Trigger when the user asks "how did the Bundestag
  vote on <bill>?", "which parties backed <motion>?", "show the roll-call result
  for <poll>", "how did the fractions split on <topic>?", or wants the per-party
  yes/no breakdown of a named vote.
version: 1.0.0
userInvocable: true
---

# Abgeordnetenwatch Poll Breakdown

Take a named roll-call vote and show **how each fraction voted** — the yes / no / abstain /
no-show split per party group, and the overall result.

## Tooling

This skill drives the `abgeordnetenwatch` command. **Before anything else, validate it is available** — run `command -v abgeordnetenwatch` (or `abgeordnetenwatch --help`). If it is not on your PATH, STOP and inform the user that the `abgeordnetenwatch` CLI (`@maschinenlesbar.org/abgeordnetenwatch-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

Data comes from the open abgeordnetenwatch.de API v2 — read-only, **no API key**, **CC0 1.0**. Always pass `--compact` and `--data-only`.

## Step 1 — Find the poll

Each poll belongs to a parliament period (`field_legislature`). Browse a parliament's recent
polls, optionally narrowing by topic; read `field_intro` and `field_accepted` for context.

```bash
# recent polls in a parliament period (find the period id via `list parliament-periods`):
abgeordnetenwatch list polls field_legislature=<PERIOD_ID> --sort-by id --sort-direction desc \
  --range-end 20 --data-only --compact \
  | jq -c '.[] | {id, label, date: .field_poll_date, accepted: .field_accepted}'
```

> Poll text is German. To narrow by subject, filter on a topic id
> (`field_topics=<TOPIC_ID>`, ids from `abgeordnetenwatch list topics`). Confirm the right
> poll with the user by `label` + `field_poll_date` before breaking it down.

## Step 2 — Pull every vote on the poll

Filter votes by `poll=<id>`. **The page size is capped at 100**, and a Bundestag roll-call
has ~700 votes, so you must page through all of them:

```bash
POLL=<POLL_ID>
total=$(abgeordnetenwatch count votes poll=$POLL | jq .total)
: > /tmp/pv.json
for start in $(seq 0 100 $((total - 1))); do
  abgeordnetenwatch list votes poll=$POLL --range-start $start --range-end 100 \
    --data-only --compact | jq -c '.[]' >> /tmp/pv.json
done
echo "collected $(wc -l < /tmp/pv.json) of $total"
```

> **Do not skip the paging loop.** Reading only the first 100 votes of a ~700-vote Bundestag
> poll gives a wrong breakdown that *looks* complete. Verify the collected line count equals
> `total` before tallying.

## Step 3 — Tally by fraction

```bash
jq -s '
  group_by(.fraction.label)
  | map({
      fraction: (.[0].fraction.label // "—"),
      yes:     (map(select(.vote=="yes"))     | length),
      no:      (map(select(.vote=="no"))      | length),
      abstain: (map(select(.vote=="abstain")) | length),
      no_show: (map(select(.vote=="no_show")) | length),
      total: length
    })
  | sort_by(-.total)
' /tmp/pv.json
```

## Step 4 — Brief the user

```
Roll-call breakdown — "<poll label>" (<parliament>, <date>) — accepted: yes
Overall: 440 yes · 151 no · 50 abstain

By fraction:
  EVP        30 yes ·  0 no ·  0 abstain ·  0 no-show
  S&D        …
  …
```

Rules:
- Lead with the **poll label, parliament, date and outcome** (`field_accepted`).
- Give the **overall yes/no/abstain** first, then the per-fraction table sorted by size.
- Keep `no_show` as its own column — it is non-participation, not a "no".
- **Watch the scope note:** for EU-Parliament polls, abgeordnetenwatch records only the
  **German** MEPs' votes, so the per-fraction counts and the overall total reflect the German
  delegation, not all ~720 MEPs. The poll's `field_intro` usually states this — surface it so
  the numbers aren't misread as the whole house.
- Cite the poll id; offer its `abgeordnetenwatch_url`. For one member's vote across many
  polls, use **abgeordnetenwatch-voting-record** instead.
