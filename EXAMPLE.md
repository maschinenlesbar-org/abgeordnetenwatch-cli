# Examples

Real examples for the Claude Code skills of the `abgeordnetenwatch` plugin, one per skill: a request,
the `abgeordnetenwatch` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 6 October 2026 with `abgeordnetenwatch` 0.2.0.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [abgeordnetenwatch-poll-breakdown](#abgeordnetenwatch-poll-breakdown) · [abgeordnetenwatch-sidejobs](#abgeordnetenwatch-sidejobs) · [abgeordnetenwatch-voting-record](#abgeordnetenwatch-voting-record)

## abgeordnetenwatch-poll-breakdown

> How did the parties vote on the Greens' bill for a 130 km/h speed limit on the Autobahn?

```bash
abgeordnetenwatch list parliament-periods parliament=5 --sort-by id --sort-direction desc --range-end 5 --data-only --compact
abgeordnetenwatch list polls field_legislature=161 'label[cn]=Tempolimit' --sort-by field_poll_date --sort-direction desc --range-end 20 --data-only --compact
abgeordnetenwatch count votes poll=6600                      # 630
abgeordnetenwatch list votes poll=6600 --range-start 0 --range-end 1000 --data-only --compact   # the skill's loop: one page
```

Period 161 is the Bundestag 2025 - 2029. The poll listing, sorted by `field_poll_date` as the
skill says and narrowed to the subject with a `label[cn]` filter, had one match: poll 6600. The
paging loop collected 630 of 630 votes (630 distinct ids) in one 1000-row page, and the totals
match the poll text (467 no, 137 yes, no abstentions).

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

What it was: a bill by the Greens for a general 130 km/h limit on Autobahns and similar
multi-lane roads (100 km/h stays the rule on rural roads), plus a government report on fuel use,
energy prices, CO₂, air quality and road deaths five months after it took effect. The
Verkehrsausschuss recommended rejection; the coalition and the AfD voted it down together.
Poll 6600 · https://www.abgeordnetenwatch.de/bundestag/21/abstimmungen/einfuehrung-eines-allgemeinen-tempolimits
```

Next steps offered: the same breakdown for another vote of the period, or one member's record
via abgeordnetenwatch-voting-record.

## abgeordnetenwatch-sidejobs

> What does Gregor Gysi earn on the side, and who pays him?

```bash
abgeordnetenwatch list politicians 'last_name[cn]=Gysi' --range-end 10 --data-only --compact
abgeordnetenwatch list candidacies-mandates politician=79334 current_on=all --data-only --compact
abgeordnetenwatch count sidejobs mandates=68562              # 89
abgeordnetenwatch list sidejobs mandates=68562 --range-end 1000 --data-only --compact > sj.json
```

One politician matched (id 79334, Die Linke, born 1948). With `current_on=all` the mandate
lookup listed six Bundestag mandates (2005 - 2009 to 2025 - 2029); the brief covers the most
recent, 68562, and offers the others. Every entry with an income band also has an exact
amount, so the brief uses the amounts; per-payer sums add exact figures only.

```
Side jobs — Gregor Gysi (Die Linke), Bundestag 2025 - 2029  ·  mandate 68562
89 disclosed activities: 85 with a declared amount, 4 without an amount
(64 marked "Einkommen im Jahr 2025", 22 "Einkommen im Jahr 2026", 3 unmarked)

Largest single declared amounts:
• Publizistische Tätigkeit — Aufbau Verlage GmbH & Co. KG — declared €10,321.53 (band 3) · Berlin
• Vortrag „Investmentstrategie 2026 - Europa Quo Vadis?" (Bankhaus Metzler) — Celebrity Speakers Limited — €8,000 (band 3) · Burnham (Buckinghamshire)
• Keynote bei der ARENIT Industrie GmbH — CSA Celebrity Speakers GmbH — €8,000 (band 3) · Hamburg
• Publizistische Tätigkeit — Aufbau Verlage GmbH & Co. KG — €8,000 (band 3) · Berlin
• Vortrag bei der Jahrestagung des VDKL, Bonn — Econ Referenten-Agentur - Dölle & Gissing GbR — €7,200 (band 3) · Leipzig
• Gespräch „Blick auf die deutsche Wirtschaft und der globale Vergleich" — Synsero Expert GmbH — €7,000 (band 2) · München
• Mitglied in der Jury zur Vergabe des Powered by Philip Morris Award — Boros GmbH — €7,000 (band 2) · Berlin
  … 78 more, mostly talks and book events at €1,100–€7,000

Most frequent payers (entries · sum of declared amounts):
  Tränenpalast Management GmbH                    19 · €37,300    ("Gespräch mit …" series)
  Openminds Media GmbH                             9 · €22,475    (talks and podcasts with Guttenberg)
  ART 28 GmbH & Co. KG                             7 · €14,000
  kulturbotschafter EVENTS GbR                     6 · €24,100.74 (book presentations)
  Lausitz.Live GmbH                                5 · €7,500
  Jahn Event                                       5 · €6,600
  Econ Referenten-Agentur - Dölle & Gissing GbR    4 · €27,200
  MEET Live GmbH                                   3 · €18,000
  … 22 more payers, incl. Spielbank Berlin (€6,302.52) and Knorr Bremse AG (€4,000)

Disclosed without an amount: Rechtsanwalt und Publizist (no payer named); Beteiligung and
"Rechtsanwalt - Mandant 2" at Venedey, Dr. Gysi, Holter, Höfler, Rechtsanwälte in Partnerschaft;
Mitglied des Politischen Beirates, BVMW.
These are self-disclosures under the Bundestag code of conduct.
Profile: https://www.abgeordnetenwatch.de/profile/gregor-gysi
```

Next steps offered: the disclosures of an earlier period (mandate 53789, 2021 - 2025).

## abgeordnetenwatch-voting-record

> How has Heidi Reichinnek voted in the Bundestag so far this term?

```bash
abgeordnetenwatch list politicians 'last_name[cn]=Reichinnek' --range-end 10 --data-only --compact
abgeordnetenwatch list candidacies-mandates politician=149570 current_on=all --data-only --compact   # 68819 (2025 - 2029), 53483 (2021 - 2025)
abgeordnetenwatch count votes mandate=68819                  # 72, one page
abgeordnetenwatch list votes mandate=68819 --range-end 1000 --data-only --compact > v.json
abgeordnetenwatch list polls field_legislature=161 --range-end 1000 --data-only --compact   # poll dates
```

The mandate lookup with `current_on=all` returned both seats; the brief covers the current one.
Vote records carry no date, so the poll dates were joined in to place the no-shows: eight fall on
one day, two on the latest sitting.

```
Voting record — Heidi Reichinnek (Die Linke), Bundestag 2025 - 2029
politician 149570 · mandate 68819
72 recorded roll-call votes (2025-06-25 – 2026-09-25): 23 yes · 35 no · 4 abstain · 10 no-show
(no_show = did not participate; 8 on 2025-11-13, 2 on 2026-09-25)

Recent notable votes:
• no  — Modernisierung des Bundespolizeigesetzes (6662)
• yes — Klimaanpassung und Naturschutz im Grundgesetz verankern (6664)
• yes — Einführung eines allgemeinen Tempolimits (6600)
• no  — GKV-Reform (6601)
• no  — Gebäudemodernisierungsgesetz (6605)
• no  — Ukraine zusätzlich militärisch und humanitär unterstützen (6598)
• no  — Schlussabstimmung zum Haushaltsgesetz 2026 (6351)
• no  — Modernisierung des Wehrdienstes (6359)
• no  — Umgestaltung des Bürgergelds zur neuen Grundsicherung (SGB II) (6422)
• yes — Mietwuchergesetz (6311)
Not taking part on 2026-09-25: Tankrabatt für Benzin und Diesel; Einführung einer Übergewinnsteuer.
Abstained: Stabilisierung des Rentenniveaus und Gleichstellung der Kindererziehungszeiten;
Eingefrorenes russisches Staatsvermögen nicht der Ukraine zur Verfügung stellen (both 2025-12-05);
Keine stärkere Absicherung des EU-Förderprogramms LEADER (2026-05-08);
Ablehnung des Grünen-Antrags gegen die Weiterführung der Nord-Stream-Pipelines (2025-06-25).

Only roll-call (namentliche) votes are recorded by name, so this is a sample of decisions.
Profile: https://www.abgeordnetenwatch.de/profile/heidi-reichinnek
```

Next steps offered: the 2021 - 2025 record (mandate 53483), or a per-fraction check of any poll
above with abgeordnetenwatch-poll-breakdown.
