---
name: abgeordnetenwatch-sidejobs
description: >
  Surface a German politician's disclosed side income (Nebentätigkeiten) from
  the abgeordnetenwatch.de API, using the abgeordnetenwatch-cli. Trigger when the
  user asks "what side jobs does <MP> have?", "Nebeneinkünfte von <name>", "who
  pays <politician>?", "which MPs have the most side income?", or wants a
  transparency check on a member's outside earnings and who funds them.
version: 1.0.0
userInvocable: true
---

# Abgeordnetenwatch Side Jobs

Report a politician's **disclosed paid side activities** — the job title, the paying
organisation, and the declared income — from abgeordnetenwatch's Nebentätigkeiten data.

## Tooling

This skill drives the `abgeordnetenwatch` command. **Before anything else, validate it is available** — run `command -v abgeordnetenwatch` (or `abgeordnetenwatch --help`). If it is not on your PATH, STOP and inform the user that the `abgeordnetenwatch` CLI (`@maschinenlesbar.org/abgeordnetenwatch-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

Data comes from the open abgeordnetenwatch.de API v2 — read-only, **no API key**, **CC0 1.0**. Always pass `--compact` and `--data-only`. An empty array is a valid, informative answer: the member disclosed no side jobs.

## Step 1 — Resolve politician → mandate

Side jobs hang off a **mandate**, not the politician directly, so resolve the name to a
mandate id first (same first two steps as **abgeordnetenwatch-voting-record**):

```bash
abgeordnetenwatch list politicians 'last_name[cn]=Stracke' --range-end 10 --data-only --compact \
  | jq -c '.[] | {id, label, party: .party.label}'
abgeordnetenwatch list candidacies-mandates politician=<POLITICIAN_ID> --data-only --compact \
  | jq -c '.[] | select(.type=="mandate") | {mandate_id: .id, period: .parliament_period.label}'
```

## Step 2 — Pull the side jobs

**The filter parameter is `mandates` (plural)** — it is the name of the array field on the
sidejob record. `mandate=` / `politician=` are **rejected** (HTTP 500). This is the single
easiest thing to get wrong:

```bash
abgeordnetenwatch count sidejobs mandates=<MANDATE_ID>
abgeordnetenwatch list sidejobs mandates=<MANDATE_ID> --range-end 100 --data-only --compact > /tmp/sj.json
```

> Across mandates the filter key is always the *field name as it appears in the JSON*. For
> side jobs that array field is `mandates`. (Filtering by the paying organisation uses
> `sidejob_organization=<id>`.)

## Step 3 — The fields that matter

| Path | Meaning |
|---|---|
| `label` / `job_title_extra` | What the activity is |
| `sidejob_organization.label` | **Who pays** — the organisation |
| `income` | Exact amount, when disclosed (number) |
| `income_level` | Income **band code** (e.g. "1".."10") used when no exact figure is given |
| `interval` | Payment interval code (one-off vs recurring); often null |
| `field_city.label` / `field_country.label` | Where the payer is |
| `field_topics[].label` | Topic tags |
| `data_change_date` | When the disclosure was last updated |

```bash
jq -c '.[] | {job: .label, payer: .sidejob_organization.label, income, income_level}' /tmp/sj.json
```

> **Income is mostly a band, not a number.** Many entries give `income_level` (a coded band)
> rather than an exact `income`. Present what is disclosed and label it "declared"; never
> infer a precise figure from a band, and never sum bands into a fake total. `income: null`
> + `income_level: null` = "disclosed, amount not quantified" (e.g. reimbursed travel).

## Step 4 — Brief the user

```
Side jobs — Stephan Stracke (CSU), Bundestag 2025–2029  ·  mandate 68920
4 disclosed activities:
• Mitglied des Stadtrates — Stadt Kaufbeuren — declared €70 (2026) · Kaufbeuren, DE
• Übernahme Reisekosten — <payer> — income band <n>
  …
```

Rules:
- Lead with the member and the **count** of disclosed side jobs.
- Always name the **paying organisation**; that is the transparency point.
- Show income as **exact amount when given, otherwise the band**, labelled "declared".
- These are **self-disclosures** under the members' code of conduct — report what is
  declared; absence of an entry means "nothing disclosed", not "no outside income".
- For a "who earns the most" ranking, you would sweep `sidejobs` across many mandates and
  rank by `income` — note that band-only entries can't be ranked precisely, and say how many
  you dropped.
- Cite the mandate id and offer the member's `abgeordnetenwatch_url`.
