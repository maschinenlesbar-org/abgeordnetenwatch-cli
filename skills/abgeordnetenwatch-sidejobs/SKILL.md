---
name: abgeordnetenwatch-sidejobs
description: >
  Surface a German politician's disclosed side income (Nebentätigkeiten) from
  the abgeordnetenwatch.de API, using the abgeordnetenwatch-cli. Trigger when the
  user asks "what side jobs does an MP have?", "Nebeneinkünfte von einem
  Politiker", "who pays a politician?", "which MPs have the most side income?",
  or wants a
  transparency check on a member's outside earnings and who funds them.
compatibility: >
  Requires the `abgeordnetenwatch` CLI (npm package
  @maschinenlesbar.org/abgeordnetenwatch-cli) on PATH, installed by the user;
  the skill never installs it. Uses jq for JSON filtering. Network access to
  www.abgeordnetenwatch.de.
---

# Abgeordnetenwatch Side Jobs

Report a politician's **disclosed paid side activities** — the job title, the paying
organisation, and the declared income — from abgeordnetenwatch's Nebentätigkeiten data.

## Tooling

This skill drives the `abgeordnetenwatch` command. **Before anything else, validate it is available** — run `command -v abgeordnetenwatch` (or `abgeordnetenwatch --help`). If it is not on your PATH, STOP and inform the user that the `abgeordnetenwatch` CLI (`@maschinenlesbar.org/abgeordnetenwatch-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

Data comes from the open abgeordnetenwatch.de API v2 — read-only, **no API key**, **CC0 1.0**. Always pass `--compact` and `--data-only`. An empty array is a valid, informative answer: the member disclosed no side jobs.

## Step 1 — Resolve politician → mandate

Side jobs hang off a **mandate**, not the politician directly, so resolve the name to a
mandate id first (same first two steps as **abgeordnetenwatch-voting-record**):

```bash
abgeordnetenwatch list politicians 'last_name[cn]=Stracke' --range-end 10 --data-only --compact \
  | jq -c '.[] | {id, label, party: .party.label}'
abgeordnetenwatch list candidacies-mandates politician=<POLITICIAN_ID> current_on=all --data-only --compact \
  | jq -c '.[] | select(.type=="mandate") | {mandate_id: .id, period: .parliament_period.label}'
```

> **Keep `current_on=all`.** Without it the API returns only the mandate current today, so a
> member's earlier periods never show up. Side jobs are disclosed per mandate: pick the period
> the user means (default: the most recent, listed first) and offer the others.

## Step 2 — Pull the side jobs

**The filter parameter is `mandates` (plural)** — it is the name of the array field on the
sidejob record. `mandate=` / `politician=` are **rejected** (HTTP 500). This is the single
easiest thing to get wrong:

```bash
abgeordnetenwatch count sidejobs mandates=<MANDATE_ID>
abgeordnetenwatch list sidejobs mandates=<MANDATE_ID> --range-end 1000 --data-only --compact > /tmp/sj.json
```

> `--range-end` is the page size, honoured up to 1000 (default 100). If `count` is larger than
> the page, fetch the rest with `--range-start`.

> Across mandates the filter key is always the *field name as it appears in the JSON*. For
> side jobs that array field is `mandates`. (Filtering by the paying organisation uses
> `sidejob_organization=<id>`.)

## Step 3 — The fields that matter

| Path | Meaning |
|---|---|
| `label` / `job_title_extra` | What the activity is |
| `sidejob_organization.label` | **Who pays** — the organisation |
| `income` | Exact amount, when disclosed (number) |
| `income_level` | Income **band code** (e.g. "1".."10"); on recent disclosures it usually sits next to the exact `income`, on older ones it is the only figure |
| `interval` | Payment interval code (one-off vs recurring); often null |
| `field_city.label` / `field_country.label` | Where the payer is |
| `field_topics[].label` | Topic tags |
| `data_change_date` | When the disclosure was last updated |

```bash
jq -c '.[] | {job: .label, payer: .sidejob_organization.label, income, income_level}' /tmp/sj.json
```

> **Band or amount depends on the period.** Bundestag disclosures up to the 2017 - 2021
> period carry only `income_level` (a coded band), no `income`. From 2021 - 2025 on,
> quantified entries carry an exact `income`, usually together with its band. Check which
> fields are filled rather than assuming either. Present what is disclosed and label it
> "declared"; when `income` is present, use it and don't show the band as a second amount;
> never infer a precise figure from a band, and never sum bands into a fake total.
> `income: null` + `income_level: null` = "disclosed, amount not quantified" (e.g. reimbursed
> travel) — a common case, not an error.

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
