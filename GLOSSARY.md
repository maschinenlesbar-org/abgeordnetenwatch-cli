# Glossary

Domain and technical terms you meet when using `abgeordnetenwatch`. For commands and options
see the **[README](README.md)**; every field of every entity is described in
**[openapi.yaml](openapi.yaml)**. The data is German, so labels and free text are German too.

## abgeordnetenwatch.de

**abgeordnetenwatch.de.** A German parliamentary-monitoring platform run by Parliament Watch
e.V. (Verein zur Förderung der parlamentarischen Kontrolle e.V.). Its open **API v2**
(`https://www.abgeordnetenwatch.de/api/v2`) is read-only and needs no API key.

**Entity / collection.** One of the API's 18 record types. The collection name is the URL path
segment that `list`, `get` and `count` take as `<entity>`; `abgeordnetenwatch entities` prints
all 18. Names are plural, with hyphens between words (`parliament-periods`; `election-program`
is singular). The `entity_type` inside a record is singular with underscores; committees and
polls report `node`, topics, cities and countries `taxonomy_term`.

**Roll-call vote (namentliche Abstimmung).** A vote that records each member's choice by name.
Only these appear as polls, so the data is a selection of a parliament's decisions.

## Entities

| Collection | `entity_type` | One record is |
|---|---|---|
| `parliaments` | `parliament` | the Bundestag, the EU-Parlament or one of the 16 state parliaments |
| `parliament-periods` | `parliament_period` | a legislative period or an election of one parliament |
| `politicians` | `politician` | a person |
| `candidacies-mandates` | `candidacy_mandate` | a politician's candidacy in an election, or their seat in a period |
| `electoral-lists` | `electoral_list` | a party list for one period (`name`, e.g. `Landesliste SPD`) |
| `constituencies` | `constituency` | a constituency (Wahlkreis) with `number` and `name` |
| `parties` | `party` | a party, with `full_name` and `short_name` |
| `fractions` | `fraction` | a parliamentary group (Fraktion) in one period |
| `election-program` | `election_program` | a party's election programme for one period; `file` is the PDF URL |
| `committees` | `node` | a committee (Ausschuss) of one period |
| `committee-memberships` | `committee_membership` | a mandate's membership in a committee |
| `polls` | `node` | a roll-call vote |
| `votes` | `vote` | how one mandate voted in one poll |
| `sidejobs` | `sidejob` | a disclosed side job (Nebentätigkeit) |
| `sidejob-organizations` | `sidejob_organization` | an organisation named in side jobs |
| `topics` | `taxonomy_term` | a topic term, e.g. `Gesundheit` |
| `cities` | `taxonomy_term` | a city term used by side jobs and organisations |
| `countries` | `taxonomy_term` | a country term used by side jobs and organisations |

## Parliaments and people

**Parliament (`parliaments`).** `label` is the short name (`Bundestag`, `Hessen`,
`EU-Parlament`), `label_external_long` the full one (`Landtag Hessen`). `current_project`
references the period that is active now, which can be an election period (`Berlin Wahl 2026`).

**Parliament period (`parliament-periods`).** A phase of one `parliament`, linked to its
`previous_period`. `type` is `legislature` (a Wahlperiode such as `Bundestag 2025 - 2029`,
with `start_date_period` and `end_date_period`) or `election` (such as `Bundestag Wahl 2025`,
with `election_date`).

**Politician (`politicians`).** Key fields: `first_name`, `last_name`, `field_title` (academic
title), `sex` (`m`, `f`, `d` for diverse, or `null`), `year_of_birth` (can be `null`), `party`
(current party), `occupation`, `qid_wikidata`, and `abgeordnetenwatch_url` (the public
profile).

**Candidacy / mandate (`candidacies-mandates`).** Links a `politician` to a
`parliament_period`. `type` is `candidacy` (stood in an `election` period such as
`Bundestag Wahl 2025`) or `mandate` (held a seat in a `legislature` period such as
`Bundestag 2025 - 2029`). Votes, side jobs and committee memberships belong to the
**mandate**, so resolve a politician id to a mandate id first.

**`current_on`.** A filter on `candidacies-mandates`. Without it the API returns only the
records current today, so a politician's earlier mandates are missing; `current_on=all`
returns every record, `current_on=2022-01-01` those current on that date.

**Electoral data (`electoral_data`).** Embedded in a candidacy/mandate: `electoral_list`,
`list_position`, `constituency`, `constituency_result` (vote share in percent) and
`mandate_won`, which is `constituency` (Direktmandat), `list` (won via the party list) or
`moved_up` (nachgerückt as a successor).

**Fraction membership (`fraction_membership`).** An array on a candidacy/mandate: `fraction`,
`valid_from`, `valid_until` (`null` while ongoing).

**Party vs. fraction.** A **party** (`parties`, e.g. `CDU`) is not tied to a period. A
**fraction** belongs to one period: its `label` says which (`SPD (Berlin 2021 - 2026)`) and
`legislature` references it. Politicians carry a `party`; votes carry the `fraction` at the
time of the vote.

## Polls, votes and committees

**Poll (`polls`).** `label` (title), `field_poll_date`, `field_accepted` (`true`/`false`),
`field_legislature` (the period), `field_intro` (HTML description), `field_topics`,
`field_committees`. Some labels describe a rejection (`Ablehnung des Antrags …`), so read
`field_accepted` together with `label` and `field_intro`.

**Vote (`votes`).** One mandate's vote in one poll: `mandate`, `poll`, `fraction`,
`reason_no_show` (e.g. `maternity_protection`) and `vote`:

| `vote` | Meaning |
|---|---|
| `yes` | voted yes |
| `no` | voted no |
| `abstain` | abstained |
| `no_show` | did not take part; not a `no` |

A poll has one vote record per mandate (630 for Bundestag poll 6600), so `poll=<id>` can need
several pages. For EU-Parlament polls only the German MEPs' votes are recorded (96 for poll
6593).

**Committee membership (`committee-memberships`).** Links a `committee` (which belongs to a
period through `field_legislature`) to a `candidacy_mandate`. `committee_role` values seen:
`member`, `alternate_member`, `chairperson`, `vice_chairperson`, `spokesperson`,
`advisory_member`.

## Side jobs

**Side job (`sidejobs`).** An activity disclosed for one or more mandates; `label` describes it.

| Field | Meaning |
|---|---|
| `mandates` | the mandates it is disclosed for (an array) |
| `sidejob_organization` | the organisation, a reference; can be `null` |
| `income` | the declared amount, a number |
| `income_level` | the income band, a string code (`"1"` to `"10"`) |
| `interval` | a payment interval code (`"1"`, `"2"`) or `null` |
| `category` | a category code, a numeric string (e.g. `"29231"`) |
| `field_city`, `field_country`, `field_topics` | place and topic terms |
| `additional_information` | HTML free text |
| `data_change_date`, `created` | last change (date), creation time (Unix seconds) |

**Band vs. amount.** Older disclosures (Bundestag 2013 - 2017) carry only `income_level`;
recent ones (Bundestag 2025 - 2029) carry both `income_level` and `income`. Don't turn a band
into an amount. Both `null` means disclosed without an amount.

**Taxonomy term (`topics`, `cities`, `countries`).** A vocabulary entry (`label`,
`description`, `parent`) that records point to through `field_topics`, `field_city` and
`field_country`.

## Ids and references

**`id` / `label`.** Every record has a numeric `id`, a display `label`, an `api_url` and often
an `abgeordnetenwatch_url` (its page on the website). `get <entity> <id>` fetches one record;
the CLI rejects `0` and non-numeric ids.

**Reference.** A related record embedded as a small object with `id`, `entity_type`, `label`,
`api_url` and sometimes `abgeordnetenwatch_url`, e.g. `party` on a politician. Fetch the full
record with `get` and the reference's `id`.

**Filter by relation.** Pass the related record's id under the field name used in the JSON:

| To get | Command |
|---|---|
| a parliament's periods | `list parliament-periods parliament=<id>` |
| a politician's candidacies and mandates | `list candidacies-mandates politician=<id>` |
| a period's candidacies and mandates | `list candidacies-mandates parliament_period=<id>` |
| a period's polls | `list polls field_legislature=<id>` |
| polls on a topic | `list polls field_topics=<id>` |
| all votes in a poll | `list votes poll=<id>` |
| a mandate's votes | `list votes mandate=<id>` |
| a mandate's side jobs | `list sidejobs mandates=<id>` (plural; `mandate=` fails) |
| an organisation's side jobs | `list sidejobs sidejob_organization=<id>` |
| a mandate's committees | `list committee-memberships candidacy_mandate=<id>` |

## Filtering, sorting and paging

**Filter (`key=value`).** Positional arguments after the entity, sent as query parameters
(`sex=f`). A parameter the collection doesn't accept returns HTTP 500, e.g.
`The following parameter(s) are not valid: mandate` on `sidejobs`.

**Operator (`field[op]=value`).** A bracket suffix on the key: `eq` (equal), `ne` (not equal),
`gt`, `gte`, `lt`, `lte` (greater or less than, or equal), `cn` (contains, ignoring case:
`'last_name[cn]=reichinnek'`) and `sw` (starts with: `'last_name[sw]=Mü'`). Quote these
filters so the shell leaves the brackets alone. The CLI rejects a missing `=`, any other
operator (`[in]`, the `[entity.id]` form), a repeated key and a plain key next to an operator
key on the same field (`sex=f 'sex[ne]=m'`: the API would keep only one) as usage errors; one
field with two different operators is fine.

**Sorting (`--sort-by`, `--sort-direction`).** Sent as `sort_by` and `sort_direction` (`asc`
or `desc`). With `--sort-by` alone the API sorts **descending**. Not every field is sortable:
polls reject `id` but accept `field_poll_date`. Without `--sort-by` the order depends on the
collection (`parliaments` highest id first, `topics` by label).

**Paging (`--range-start`, `--range-end`).** Sent as `range_start` (0-based offset) and
`range_end`, which is the **page size**, not an end index. The API honours up to 1000; a
larger value falls back to 100. Raise `--range-start` by the page size until you have
`meta.result.total` records.

## Output

**Envelope (`meta`, `data`).** Every response is `{ meta, data }`; `data` is an array for
`list` and an object for `get`. `--data-only` prints only `data`, `--compact` prints the JSON
on one line. `count` prints `{ entity, total }`, `entities` prints `{ entities: [...] }`.

**`meta.result`.** For `list`: `count` (records in this page), `total` (all matches),
`range_start`, `range_end`. For `get`: `entity_id` (the id as a string) and `entity_type`.

**`meta.status` / `meta.status_message`.** `ok` and an empty message on success. On an error
the CLI prints the message, e.g. `There is no party entity with id 99999999`.

**`meta.abgeordnetenwatch_api`.** The same block on every response: `version` (`2.9.0`),
`changelog`, `licence` (`CC0 1.0`), `licence_link` and `documentation`.

## Data license

**CC0 1.0.** The data is dedicated to the public domain under CC0 1.0 Universal, as every
response states in `meta.abgeordnetenwatch_api.licence`. You may use, change and redistribute
it, commercially too. Attribution is not required but requested:
`Quelle: abgeordnetenwatch.de (https://www.abgeordnetenwatch.de) — Daten unter CC0 1.0.`

**Personal data.** Names, votes and side-income disclosures are personal data: CC0 waives
copyright, not GDPR (DSGVO) obligations. HTML fields such as `field_intro` can quote
third-party material, and the website, logo and branding are not covered. See
[DATA_LICENSE.md](DATA_LICENSE.md).

## Exit codes

**Exit codes.** `0` success (also `--help` and `--version`) · `1` API error, network or parse
failure · `2` usage error (unknown entity, bad option, filter or id) · `4` HTTP 404 (unknown
collection path).

**HTTP 500.** The API answers a missing id, a parameter it doesn't accept and an unsortable
field with HTTP 500, not 404 or 400; the CLI prints the reason and exits `1`. HTTP 429 and
503 are retried automatically (`--max-retries`, default 2).

> **Library & internals.** The TypeScript client, request engine, retries, redirects and
> error types are described in **[DEVELOPING.md](DEVELOPING.md)**.
