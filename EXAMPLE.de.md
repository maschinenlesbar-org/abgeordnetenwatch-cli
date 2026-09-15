# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `abgeordnetenwatch`, eines pro Skill: eine
Anfrage, die `abgeordnetenwatch`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 15. September 2026 mit `abgeordnetenwatch` 0.0.7 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [abgeordnetenwatch-poll-breakdown](#abgeordnetenwatch-poll-breakdown) · [abgeordnetenwatch-sidejobs](#abgeordnetenwatch-sidejobs) · [abgeordnetenwatch-voting-record](#abgeordnetenwatch-voting-record)

## abgeordnetenwatch-poll-breakdown

> Wie haben die Fraktionen über den Gesetzentwurf der Grünen für Tempo 130 auf Autobahnen abgestimmt?

```bash
abgeordnetenwatch list parliament-periods parliament=5 --sort-by id --sort-direction desc --range-end 5 --data-only --compact
abgeordnetenwatch list polls field_legislature=161 --sort-by id --sort-direction desc --range-end 20 --data-only --compact   # Exit 1: HTTP 500 "id is not a valid value for sort_by"
abgeordnetenwatch list polls field_legislature=161 --sort-by field_poll_date --sort-direction desc --range-end 20 --data-only --compact
abgeordnetenwatch --compact get polls 6600
abgeordnetenwatch count votes poll=6600                      # 630
abgeordnetenwatch list votes poll=6600 --range-start 0 --range-end 100 --data-only --compact   # 7 Seiten, Start 0…600
```

Die im Skill vorgesehene Sortierung (`--sort-by id`) lehnt die API für Abstimmungen ab. Deshalb
hat der Skill nach `field_poll_date` sortiert. Treffer war Abstimmung 6600 (Periode 161 =
Bundestag 2025 - 2029). Die Blätterschleife hat alle 630 von 630 Stimmen geholt, und die Summen
stimmen mit dem Abstimmungstext überein (467 Nein, 137 Ja).

```
Namentliche Abstimmung – „Einführung eines allgemeinen Tempolimits" (Bundestag 2025 - 2029, 2026-07-09) – angenommen: nein
Gesamt: 137 Ja · 467 Nein · 0 Enthaltungen · 26 nicht beteiligt

Nach Fraktion:
  CDU/CSU                  0 Ja · 207 Nein · 0 Enth. · 1 nicht beteiligt
  AfD                      0 Ja · 142 Nein · 0 Enth. · 8 nicht beteiligt
  SPD                      0 Ja · 116 Nein · 0 Enth. · 4 nicht beteiligt
  BÜNDNIS 90/DIE GRÜNEN   79 Ja ·   0 Nein · 0 Enth. · 6 nicht beteiligt
  Die Linke               57 Ja ·   0 Nein · 0 Enth. · 7 nicht beteiligt
  fraktionslos             1 Ja ·   2 Nein · 0 Enth. · 0 nicht beteiligt
    (Ja: Stefan Seidler; Nein: Jan Wenzel Schmidt, Sieghard Knodel)

Worum es ging: ein Gesetzentwurf der Grünen (Drucksache 21/5319) für ein allgemeines Tempolimit
von 130 km/h auf Autobahnen und ähnlichen mehrspurigen Straßen, dazu ein Bericht der
Bundesregierung zu Kraftstoffverbrauch, CO₂ und Verkehrstoten fünf Monate nach Einführung. Der
Verkehrsausschuss hatte die Ablehnung empfohlen; Koalition und AfD stimmten gemeinsam dagegen.
Abstimmung 6600 · https://www.abgeordnetenwatch.de/bundestag/21/abstimmungen/einfuehrung-eines-allgemeinen-tempolimits
```

Als Nächstes angeboten: dieselbe Aufschlüsselung für die Abstimmung zur GKV-Reform am 10.07.2026
(Abstimmung 6601) oder das Stimmverhalten einzelner Abgeordneter über abgeordnetenwatch-voting-record.

## abgeordnetenwatch-sidejobs

> Was verdient Gregor Gysi nebenher, und wer zahlt ihm das?

```bash
abgeordnetenwatch list politicians 'last_name[cn]=Gysi' --range-end 10 --data-only --compact
abgeordnetenwatch list candidacies-mandates politician=79334 --data-only --compact
abgeordnetenwatch count sidejobs mandates=68562              # 82
abgeordnetenwatch list sidejobs mandates=68562 --range-end 100 --data-only --compact > sj.json
```

Es gab genau einen Treffer (ID 79334, Die Linke, Jahrgang 1948) mit einem aktuellen Mandat. Jeder
Eintrag mit Einkommensstufe nennt auch einen genauen Betrag. Deshalb zeigt die Übersicht die
Beträge; die Summen je Zahler addieren nur genaue Angaben.

```
Nebentätigkeiten – Gregor Gysi (Die Linke), Bundestag 2025 - 2029  ·  Mandat 68562
82 veröffentlichte Tätigkeiten: 78 mit angegebenem Betrag, 4 ohne Betrag
(64 mit „Einkommen im Jahr 2025", 15 mit „Einkommen im Jahr 2026", 3 ohne Angabe)

Höchste Einzelbeträge (angegeben):
• Publizistische Tätigkeit – Aufbau Verlage GmbH & Co. KG – 10.321,53 € (Stufe 3) · Berlin
• Vortrag „Investmentstrategie 2026 - Europa Quo Vadis?" (Bankhaus Metzler) – Celebrity Speakers Limited – 8.000 € (Stufe 3) · Burnham (Buckinghamshire)
• Keynote bei der ARENIT Industrie GmbH – CSA Celebrity Speakers GmbH – 8.000 € (Stufe 3) · Hamburg
• Vortrag bei der Jahrestagung des VDKL, Bonn – Econ Referenten-Agentur - Dölle & Gissing GbR – 7.200 € (Stufe 3)
• Mitglied in der Jury zur Vergabe des Powered by Philip Morris Award – Boros GmbH – 7.000 € (Stufe 2) · Berlin
• Mitglied des Beirates für gemeinnützige Zwecke – Spielbank Berlin GmbH & Co. KG – 6.302,52 € (Stufe 2)
  … 72 weitere, meist Vorträge und Buchveranstaltungen zu 1.100–7.000 €

Häufigste Zahler (Einträge · Summe der angegebenen Beträge):
  Tränenpalast Management GmbH                    18 · 35.300 €     (Reihe „Gespräch mit …")
  Openminds Media GmbH                             8 · 19.975 €     (Gysi gegen Guttenberg, Podcast)
  kulturbotschafter EVENTS GbR                     6 · 24.100,74 €  (Buchvorstellungen)
  ART 28 GmbH & Co. KG                             6 · 12.000 €
  Lausitz.Live GmbH                                5 · 7.500 €
  Econ Referenten-Agentur - Dölle & Gissing GbR    4 · 27.200 €
  … 23 weitere Zahler, darunter Knorr Bremse AG (4.000 €)

Ohne Betrag angegeben: Rechtsanwalt und Publizist (kein Zahler genannt); Beteiligung und
„Rechtsanwalt - Mandant 2" bei Venedey, Dr. Gysi, Holter, Höfler, Rechtsanwälte in Partnerschaft;
Mitglied des Politischen Beirates, BVMW.
Es handelt sich um Selbstauskünfte nach den Verhaltensregeln des Bundestages.
Profil: https://www.abgeordnetenwatch.de/profile/gregor-gysi
```

## abgeordnetenwatch-voting-record

> Wie hat Heidi Reichinnek in dieser Wahlperiode bisher im Bundestag abgestimmt?

```bash
abgeordnetenwatch list politicians 'last_name[cn]=Reichinnek' --range-end 10 --data-only --compact
abgeordnetenwatch list candidacies-mandates politician=149570 --data-only --compact   # nur das aktuelle Mandat
abgeordnetenwatch list candidacies-mandates politician=149570 current_on=all --data-only --compact   # zusätzlich 53483 (2021 - 2025)
abgeordnetenwatch count votes mandate=68819                  # 68, eine Seite
abgeordnetenwatch list votes mandate=68819 --range-end 100 --data-only --compact > v.json
abgeordnetenwatch list polls field_legislature=161 --range-end 100 --data-only --compact   # Abstimmungsdaten
```

Die im Skill vorgesehene Mandatsabfrage lieferte nur den aktuellen Sitz; das frühere Mandat
tauchte erst mit `current_on=all` auf. Die Abstimmungsdaten wurden ergänzt, um die fehlenden
Stimmen einzuordnen – sie fallen alle auf einen Tag.

```
Stimmverhalten – Heidi Reichinnek (Die Linke), Bundestag 2025 - 2029
Politikerin 149570 · Mandat 68819
68 namentliche Abstimmungen (2025-06-25 – 2026-07-10): 22 Ja · 34 Nein · 4 Enthaltungen · 8 nicht beteiligt
(no_show = nicht teilgenommen; alle 8 am 2025-11-13)

Auffällige Abstimmungen zuletzt:
• Ja   – Einführung eines allgemeinen Tempolimits (6600)
• Nein – GKV-Reform (6601)
• Nein – Gebäudemodernisierungsgesetz (6605)
• Nein – Ukraine zusätzlich militärisch und humanitär unterstützen (6598)
• Nein – Schlussabstimmung zum Haushaltsgesetz 2026 (6351)
• Nein – Modernisierung des Wehrdienstes (6359)
• Nein – Umgestaltung des Bürgergelds zur neuen Grundsicherung (SGB II) (6422)
• Ja   – Mietwuchergesetz (6311)
Enthaltungen: Stabilisierung des Rentenniveaus und Gleichstellung der Kindererziehungszeiten;
Eingefrorenes russisches Staatsvermögen nicht der Ukraine zur Verfügung stellen (beide 2025-12-05);
Keine stärkere Absicherung des EU-Förderprogramms LEADER (2026-05-08);
Ablehnung des Grünen-Antrags gegen die Weiterführung der Nord-Stream-Pipelines (2025-06-25).

Einzeln erfasst sind nur namentliche Abstimmungen – das ist eine Auswahl der Entscheidungen.
Profil: https://www.abgeordnetenwatch.de/profile/heidi-reichinnek
```

Als Nächstes angeboten: das Stimmverhalten 2021 - 2025 (Mandat 53483) oder für jede der
Abstimmungen oben eine Aufschlüsselung nach Fraktion mit abgeordnetenwatch-poll-breakdown.
