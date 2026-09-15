# Examples

Real examples for the Claude Code skills of the `abgeordnetenwatch` plugin, one per skill: a request,
the `abgeordnetenwatch` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 15 September 2026 with `abgeordnetenwatch` 0.0.7.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [abgeordnetenwatch-poll-breakdown](#abgeordnetenwatch-poll-breakdown) · [abgeordnetenwatch-sidejobs](#abgeordnetenwatch-sidejobs) · [abgeordnetenwatch-voting-record](#abgeordnetenwatch-voting-record)

## abgeordnetenwatch-poll-breakdown

> How did the parties vote on the Greens' bill for a 130 km/h speed limit on the Autobahn?

```bash
abgeordnetenwatch list parliament-periods parliament=5 --sort-by id --sort-direction desc --range-end 5 --data-only --compact
abgeordnetenwatch list polls field_legislature=161 --sort-by id --sort-direction desc --range-end 20 --data-only --compact   # exit 1: HTTP 500 "id is not a valid value for sort_by"
abgeordnetenwatch list polls field_legislature=161 --sort-by field_poll_date --sort-direction desc --range-end 20 --data-only --compact
abgeordnetenwatch --compact get polls 6600
abgeordnetenwatch count votes poll=6600                      # 630
abgeordnetenwatch list votes poll=6600 --range-start 0 --range-end 100 --data-only --compact   # 7 pages, start 0…600
```

The skill's own poll listing (`--sort-by id`) is rejected by the API for polls, so it sorted by
`field_poll_date` instead. Poll 6600 (period 161 = Bundestag 2025 - 2029) was the match. The
paging loop collected 630 of 630 votes, and the totals match the poll text (467 no, 137 yes).

```
Roll-call breakdown — "Einführung eines allgemeinen Tempolimits" (Bundestag 2025 - 2029, 2026-07-09) — accepted: no
Overall: 137 yes · 467 no · 0 abstain · 26 no-show

By fraction:
  CDU/CSU                  0 yes · 207 no · 0 abstain · 1 no-show
  AfD                      0 yes · 142 no · 0 abstain · 8 no-show
  SPD                      0 yes · 116 no · 0 abstain · 4 no-show
  BÜNDNIS 90/DIE GRÜNEN   79 yes ·   0 no · 0 abstain · 6 no-show
  Die Linke               57 yes ·   0 no · 0 abstain · 7 no-show
  fraktionslos             1 yes ·   2 no · 0 abstain · 0 no-show
    (yes: Stefan Seidler; no: Jan Wenzel Schmidt, Sieghard Knodel)

What it was: a Green bill (Drucksache 21/5319) for a general 130 km/h limit on Autobahns and
similar multi-lane roads, plus a government report on fuel use, CO₂ and road deaths five months
after it took effect. The Verkehrsausschuss recommended rejection; the coalition and the AfD
voted it down together.
Poll 6600 · https://www.abgeordnetenwatch.de/bundestag/21/abstimmungen/einfuehrung-eines-allgemeinen-tempolimits
```

Next steps offered: the same breakdown for the GKV-Reform vote on 2026-07-10 (poll 6601), or one
member's record via abgeordnetenwatch-voting-record.

## abgeordnetenwatch-sidejobs

> What does Gregor Gysi earn on the side, and who pays him?

```bash
abgeordnetenwatch list politicians 'last_name[cn]=Gysi' --range-end 10 --data-only --compact
abgeordnetenwatch list candidacies-mandates politician=79334 --data-only --compact
abgeordnetenwatch count sidejobs mandates=68562              # 82
abgeordnetenwatch list sidejobs mandates=68562 --range-end 100 --data-only --compact > sj.json
```

One politician matched (id 79334, Die Linke, born 1948), with one current mandate. Every entry
that has an income band also has an exact amount, so the brief uses the amounts; per-payer sums
add exact figures only.

```
Side jobs — Gregor Gysi (Die Linke), Bundestag 2025 - 2029  ·  mandate 68562
82 disclosed activities: 78 with a declared amount, 4 without an amount
(64 marked "Einkommen im Jahr 2025", 15 "Einkommen im Jahr 2026", 3 unmarked)

Largest single declared amounts:
• Publizistische Tätigkeit — Aufbau Verlage GmbH & Co. KG — declared €10,321.53 (band 3) · Berlin
• Vortrag „Investmentstrategie 2026 - Europa Quo Vadis?" (Bankhaus Metzler) — Celebrity Speakers Limited — €8,000 (band 3) · Burnham (Buckinghamshire)
• Keynote bei der ARENIT Industrie GmbH — CSA Celebrity Speakers GmbH — €8,000 (band 3) · Hamburg
• Vortrag bei der Jahrestagung des VDKL, Bonn — Econ Referenten-Agentur - Dölle & Gissing GbR — €7,200 (band 3)
• Mitglied in der Jury zur Vergabe des Powered by Philip Morris Award — Boros GmbH — €7,000 (band 2) · Berlin
• Mitglied des Beirates für gemeinnützige Zwecke — Spielbank Berlin GmbH & Co. KG — €6,302.52 (band 2)
  … 72 more, mostly talks and book events at €1,100–€7,000

Most frequent payers (entries · sum of declared amounts):
  Tränenpalast Management GmbH                    18 · €35,300    ("Gespräch mit …" series)
  Openminds Media GmbH                             8 · €19,975    (Gysi vs. Guttenberg events, podcast)
  kulturbotschafter EVENTS GbR                     6 · €24,100.74 (book presentations)
  ART 28 GmbH & Co. KG                             6 · €12,000
  Lausitz.Live GmbH                                5 · €7,500
  Econ Referenten-Agentur - Dölle & Gissing GbR    4 · €27,200
  … 23 more payers, incl. Knorr Bremse AG (€4,000)

Disclosed without an amount: Rechtsanwalt und Publizist (no payer named); Beteiligung and
"Rechtsanwalt - Mandant 2" at Venedey, Dr. Gysi, Holter, Höfler, Rechtsanwälte in Partnerschaft;
Mitglied des Politischen Beirates, BVMW.
These are self-disclosures under the Bundestag code of conduct.
Profile: https://www.abgeordnetenwatch.de/profile/gregor-gysi
```

## abgeordnetenwatch-voting-record

> How has Heidi Reichinnek voted in the Bundestag so far this term?

```bash
abgeordnetenwatch list politicians 'last_name[cn]=Reichinnek' --range-end 10 --data-only --compact
abgeordnetenwatch list candidacies-mandates politician=149570 --data-only --compact   # only the current mandate
abgeordnetenwatch list candidacies-mandates politician=149570 current_on=all --data-only --compact   # also 53483 (2021 - 2025)
abgeordnetenwatch count votes mandate=68819                  # 68, one page
abgeordnetenwatch list votes mandate=68819 --range-end 100 --data-only --compact > v.json
abgeordnetenwatch list polls field_legislature=161 --range-end 100 --data-only --compact   # poll dates
```

The skill's mandate lookup returned only the current seat; the earlier one showed up only with
`current_on=all`. Poll dates were joined in to explain the no-shows, which all fall on one day.

```
Voting record — Heidi Reichinnek (Die Linke), Bundestag 2025 - 2029
politician 149570 · mandate 68819
68 recorded roll-call votes (2025-06-25 – 2026-07-10): 22 yes · 34 no · 4 abstain · 8 no-show
(no_show = did not participate; all 8 were on 2025-11-13)

Recent notable votes:
• yes — Einführung eines allgemeinen Tempolimits (6600)
• no  — GKV-Reform (6601)
• no  — Gebäudemodernisierungsgesetz (6605)
• no  — Ukraine zusätzlich militärisch und humanitär unterstützen (6598)
• no  — Schlussabstimmung zum Haushaltsgesetz 2026 (6351)
• no  — Modernisierung des Wehrdienstes (6359)
• no  — Umgestaltung des Bürgergelds zur neuen Grundsicherung (SGB II) (6422)
• yes — Mietwuchergesetz (6311)
Abstained: Stabilisierung des Rentenniveaus und Gleichstellung der Kindererziehungszeiten;
Eingefrorenes russisches Staatsvermögen nicht der Ukraine zur Verfügung stellen (both 2025-12-05);
Keine stärkere Absicherung des EU-Förderprogramms LEADER (2026-05-08);
Ablehnung des Grünen-Antrags gegen die Weiterführung der Nord-Stream-Pipelines (2025-06-25).

Only roll-call (namentliche) votes are recorded by name, so this is a sample of decisions.
Profile: https://www.abgeordnetenwatch.de/profile/heidi-reichinnek
```

Next steps offered: the 2021 - 2025 record (mandate 53483), or a per-fraction check of any poll
above with abgeordnetenwatch-poll-breakdown.
