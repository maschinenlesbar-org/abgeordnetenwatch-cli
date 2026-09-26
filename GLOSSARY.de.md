# Glossar

Fach- und Technikbegriffe, denen Sie bei der Arbeit mit `abgeordnetenwatch` begegnen. Befehle
und Optionen beschreibt die **[README](README.md)**; jedes Feld jeder Entität ist in
**[openapi.yaml](openapi.yaml)** beschrieben. Labels und Freitexte der Daten sind deutsch.

## abgeordnetenwatch.de

**abgeordnetenwatch.de.** Eine deutsche Plattform zur Beobachtung der Parlamente, betrieben vom
Verein zur Förderung der parlamentarischen Kontrolle e.V. Ihre offene **API v2**
(`https://www.abgeordnetenwatch.de/api/v2`) ist nur lesend nutzbar und braucht keinen
API-Schlüssel.

**Entität / Sammlung.** Einer der 18 Datensatztypen der API. Der Name der Sammlung ist das
URL-Pfadsegment, das `list`, `get` und `count` als `<entity>` erwarten;
`abgeordnetenwatch entities` gibt alle 18 aus. Die Namen stehen im Plural, mehrere Wörter mit
Bindestrich (`parliament-periods`; `election-program` steht im Singular). Der `entity_type` in
einem Datensatz steht im Singular mit Unterstrichen; Ausschüsse und Abstimmungen melden `node`,
Themen, Städte und Länder `taxonomy_term`.

**Namentliche Abstimmung.** Eine Abstimmung, bei der die Stimme jedes Mitglieds mit Namen
festgehalten wird. Nur solche Abstimmungen sind enthalten; die Daten zeigen also eine Auswahl
der Entscheidungen eines Parlaments.

## Entitäten

| Sammlung | `entity_type` | Ein Datensatz ist |
|---|---|---|
| `parliaments` | `parliament` | der Bundestag, das EU-Parlament oder eines der 16 Landesparlamente |
| `parliament-periods` | `parliament_period` | eine Wahlperiode oder eine Wahl eines Parlaments |
| `politicians` | `politician` | eine Person |
| `candidacies-mandates` | `candidacy_mandate` | die Kandidatur eines Politikers bei einer Wahl oder sein Sitz in einer Periode |
| `electoral-lists` | `electoral_list` | eine Parteiliste für eine Periode (`name`, z. B. `Landesliste SPD`) |
| `constituencies` | `constituency` | ein Wahlkreis mit `number` und `name` |
| `parties` | `party` | eine Partei mit `full_name` und `short_name` |
| `fractions` | `fraction` | eine Fraktion in einer Periode |
| `election-program` | `election_program` | das Wahlprogramm einer Partei für eine Periode; `file` ist die URL des PDFs |
| `committees` | `node` | ein Ausschuss einer Periode |
| `committee-memberships` | `committee_membership` | die Mitgliedschaft eines Mandats in einem Ausschuss |
| `polls` | `node` | eine namentliche Abstimmung |
| `votes` | `vote` | wie ein Mandat bei einer Abstimmung gestimmt hat |
| `sidejobs` | `sidejob` | eine offengelegte Nebentätigkeit |
| `sidejob-organizations` | `sidejob_organization` | eine in Nebentätigkeiten genannte Organisation |
| `topics` | `taxonomy_term` | ein Themenbegriff, z. B. `Gesundheit` |
| `cities` | `taxonomy_term` | ein Ortsbegriff für Nebentätigkeiten und Organisationen |
| `countries` | `taxonomy_term` | ein Länderbegriff für Nebentätigkeiten und Organisationen |

## Parlamente und Personen

**Parlament (`parliaments`).** `label` ist der Kurzname (`Bundestag`, `Hessen`,
`EU-Parlament`), `label_external_long` der volle Name (`Landtag Hessen`). `current_project`
verweist auf die gerade aktive Periode; das kann auch eine Wahl sein (`Berlin Wahl 2026`).

**Parlamentsperiode (`parliament-periods`).** Ein Abschnitt eines Parlaments (`parliament`),
verknüpft mit der vorherigen Periode (`previous_period`). `type` ist `legislature` (eine
Wahlperiode wie `Bundestag 2025 - 2029`, mit `start_date_period` und `end_date_period`) oder
`election` (eine Wahl wie `Bundestag Wahl 2025`, mit `election_date`).

**Politiker (`politicians`).** Wichtige Felder: `first_name`, `last_name`, `field_title`
(akademischer Titel), `sex` (`m`, `f`, `d` für divers oder `null`), `year_of_birth` (kann
`null` sein), `party` (aktuelle Partei), `occupation`, `qid_wikidata` und
`abgeordnetenwatch_url` (das öffentliche Profil).

**Kandidatur / Mandat (`candidacies-mandates`).** Verknüpft einen Politiker (`politician`) mit
einer Periode (`parliament_period`). `type` ist `candidacy` (Kandidatur in einer
`election`-Periode wie `Bundestag Wahl 2025`) oder `mandate` (Sitz in einer
`legislature`-Periode wie `Bundestag 2025 - 2029`). Stimmen, Nebentätigkeiten und
Ausschussmitgliedschaften gehören zum **Mandat**; lösen Sie eine Politiker-ID daher zuerst in
eine Mandats-ID auf.

**`current_on`.** Ein Filter für `candidacies-mandates`. Ohne ihn liefert die API nur die heute
aktuellen Datensätze, frühere Mandate eines Politikers fehlen dann; `current_on=all` liefert
alle Datensätze, `current_on=2022-01-01` die an diesem Tag aktuellen.

**Wahldaten (`electoral_data`).** In eine Kandidatur bzw. ein Mandat eingebettet:
`electoral_list`, `list_position`, `constituency`, `constituency_result` (Stimmenanteil in
Prozent) und `mandate_won` mit dem Wert `constituency` (Direktmandat), `list` (über die
Parteiliste gewonnen) oder `moved_up` (als Nachfolger nachgerückt).

**Fraktionsmitgliedschaft (`fraction_membership`).** Ein Array an einer Kandidatur bzw. einem
Mandat: `fraction`, `valid_from`, `valid_until` (`null`, solange die Mitgliedschaft besteht).

**Partei und Fraktion.** Eine **Partei** (`parties`, z. B. `CDU`) ist an keine Periode
gebunden. Eine **Fraktion** gehört zu einer Periode: Ihr `label` nennt sie
(`SPD (Berlin 2021 - 2026)`), und `legislature` verweist auf sie. Politiker tragen eine
`party`, Stimmen die `fraction` zum Zeitpunkt der Abstimmung.

## Abstimmungen, Stimmen und Ausschüsse

**Abstimmung (`polls`).** `label` (Titel), `field_poll_date`, `field_accepted`
(`true`/`false`), `field_legislature` (die Periode), `field_intro` (HTML-Beschreibung),
`field_topics`, `field_committees`. Manche Titel beschreiben bereits eine Ablehnung
(`Ablehnung des Antrags …`); lesen Sie `field_accepted` daher zusammen mit `label` und
`field_intro`.

**Stimme (`votes`).** Die Stimme eines Mandats bei einer Abstimmung: `mandate`, `poll`,
`fraction`, `reason_no_show` (z. B. `maternity_protection`) und `vote`:

| `vote` | Bedeutung |
|---|---|
| `yes` | mit Ja gestimmt |
| `no` | mit Nein gestimmt |
| `abstain` | enthalten |
| `no_show` | nicht teilgenommen; kein `no` |

Eine Abstimmung hat einen Stimm-Datensatz je Mandat (630 bei Bundestagsabstimmung 6600), daher
kann `poll=<id>` mehrere Seiten umfassen. Bei Abstimmungen im EU-Parlament sind nur die Stimmen
der deutschen Abgeordneten erfasst (96 bei Abstimmung 6593).

**Ausschussmitgliedschaft (`committee-memberships`).** Verknüpft einen Ausschuss (`committee`,
über `field_legislature` einer Periode zugeordnet) mit einem Mandat (`candidacy_mandate`).
Beobachtete Werte von `committee_role`: `member`, `alternate_member`, `chairperson`,
`vice_chairperson`, `spokesperson`, `advisory_member`.

## Nebentätigkeiten

**Nebentätigkeit (`sidejobs`).** Eine für ein oder mehrere Mandate offengelegte Tätigkeit;
`label` beschreibt sie.

| Feld | Bedeutung |
|---|---|
| `mandates` | die Mandate, für die sie offengelegt ist (ein Array) |
| `sidejob_organization` | die Organisation, ein Verweis; kann `null` sein |
| `income` | der angegebene Betrag, eine Zahl |
| `income_level` | die Einkommensstufe, ein String-Code (`"1"` bis `"10"`) |
| `interval` | ein Code für das Zahlungsintervall (`"1"`, `"2"`) oder `null` |
| `category` | ein Kategorie-Code, ein numerischer String (z. B. `"29231"`) |
| `field_city`, `field_country`, `field_topics` | Orts- und Themenbegriffe |
| `additional_information` | HTML-Freitext |
| `data_change_date`, `created` | letzte Änderung (Datum), Erstellungszeit (Unix-Sekunden) |

**Stufe und Betrag.** Ältere Angaben (Bundestag 2013 - 2017) enthalten nur `income_level`;
neuere (Bundestag 2025 - 2029) enthalten `income_level` und `income`. Leiten Sie aus einer
Stufe keinen Betrag ab. Sind beide `null`, wurde die Tätigkeit ohne Betrag offengelegt.

**Taxonomie-Begriff (`topics`, `cities`, `countries`).** Ein Eintrag eines Vokabulars
(`label`, `description`, `parent`), auf den Datensätze über `field_topics`, `field_city` und
`field_country` verweisen.

## IDs und Verweise

**`id` / `label`.** Jeder Datensatz hat eine numerische `id`, ein Anzeige-`label`, eine
`api_url` und oft eine `abgeordnetenwatch_url` (seine Seite auf der Website).
`get <entity> <id>` ruft einen Datensatz ab; die CLI lehnt `0` und nicht numerische IDs ab.

**Verweis.** Ein verknüpfter Datensatz, eingebettet als kleines Objekt mit `id`, `entity_type`,
`label`, `api_url` und manchmal `abgeordnetenwatch_url`, z. B. `party` bei einem Politiker.
Den vollständigen Datensatz holen Sie mit `get` und der `id` des Verweises.

**Nach Beziehung filtern.** Übergeben Sie die ID des verknüpften Datensatzes unter dem
Feldnamen, den das JSON verwendet:

| Gesucht | Befehl |
|---|---|
| die Perioden eines Parlaments | `list parliament-periods parliament=<id>` |
| Kandidaturen und Mandate eines Politikers | `list candidacies-mandates politician=<id>` |
| Kandidaturen und Mandate einer Periode | `list candidacies-mandates parliament_period=<id>` |
| die Abstimmungen einer Periode | `list polls field_legislature=<id>` |
| Abstimmungen zu einem Thema | `list polls field_topics=<id>` |
| alle Stimmen einer Abstimmung | `list votes poll=<id>` |
| die Stimmen eines Mandats | `list votes mandate=<id>` |
| die Nebentätigkeiten eines Mandats | `list sidejobs mandates=<id>` (Plural; `mandate=` scheitert) |
| die Nebentätigkeiten einer Organisation | `list sidejobs sidejob_organization=<id>` |
| die Ausschüsse eines Mandats | `list committee-memberships candidacy_mandate=<id>` |

## Filtern, Sortieren und Paginierung

**Filter (`key=value`).** Positionsargumente nach der Entität, die als Query-Parameter
gesendet werden (`sex=f`). Einen Parameter, den die Sammlung nicht akzeptiert, beantwortet die
API mit HTTP 500, z. B. `The following parameter(s) are not valid: mandate` bei `sidejobs`.
Die Namen für Seiten und Sortierung (`range_start`, `range_end`, `sort_by`, `sort_direction`)
sind keine Filter: Die CLI weist sie ab und nennt die passende Option.

**Operator (`field[op]=value`).** Ein Suffix in eckigen Klammern am Schlüssel: `eq` (gleich),
`ne` (ungleich), `gt`, `gte`, `lt`, `lte` (größer bzw. kleiner als, oder gleich), `cn`
(enthält, ohne Beachtung der Groß- und Kleinschreibung: `'last_name[cn]=reichinnek'`) und `sw`
(beginnt mit: `'last_name[sw]=Mü'`). Setzen Sie solche Filter in Anführungszeichen, damit die
Shell die Klammern nicht auswertet. Die CLI weist ein fehlendes `=`, einen Schlüssel, der kein
Feldname mit höchstens einem Operator ist (`'[gt]=1990'`, `'year_of_birth[gt]x=1990'`), jeden
anderen Operator
(`[in]`, die Form `[entity.id]`), einen wiederholten Schlüssel und einen einfachen Schlüssel
neben einem Operator-Schlüssel für dasselbe Feld (`sex=f 'sex[ne]=m'`: die API würde nur einen
behalten) als Aufruffehler ab; ein Feld mit zwei verschiedenen Operatoren ist erlaubt.

**Sortieren (`--sort-by`, `--sort-direction`).** Gesendet als `sort_by` und `sort_direction`
(`asc` oder `desc`). Mit `--sort-by` allein sortiert die API **absteigend**. Nicht jedes Feld
ist sortierbar: Abstimmungen lehnen `id` ab, akzeptieren aber `field_poll_date`. Ohne
`--sort-by` hängt die Reihenfolge von der Sammlung ab (`parliaments` höchste ID zuerst,
`topics` nach Label).

**Paginierung (`--range-start`, `--range-end`).** Gesendet als `range_start` (Versatz ab 0)
und `range_end` – die **Seitengröße**, kein End-Index. Die API berücksichtigt bis zu 1.000;
bei einem größeren Wert fällt sie auf 100 zurück. Erhöhen Sie `--range-start` jeweils um die
Seitengröße, bis Sie `meta.result.total` Datensätze haben.

## Ausgabe

**Umschlag (`meta`, `data`).** Jede Antwort ist `{ meta, data }`; `data` ist bei `list` ein
Array, bei `get` ein Objekt. `--data-only` gibt nur `data` aus, `--compact` das JSON in einer
Zeile. `count` gibt `{ entity, total }` aus, `entities` `{ entities: [...] }`.

**`meta.result`.** Bei `list`: `count` (Datensätze auf dieser Seite), `total` (alle Treffer),
`range_start`, `range_end`. Bei `get`: `entity_id` (die ID als String) und `entity_type`.

**`meta.status` / `meta.status_message`.** Bei Erfolg `ok` und eine leere Meldung. Bei einem
Fehler gibt die CLI die Meldung aus, z. B. `There is no party entity with id 99999999`.

**`meta.abgeordnetenwatch_api`.** Derselbe Block in jeder Antwort: `version` (`2.9.0`),
`changelog`, `licence` (`CC0 1.0`), `licence_link` und `documentation`.

## Datenlizenz

**CC0 1.0.** Die Daten sind nach CC0 1.0 Universal gemeinfrei, wie jede Antwort in
`meta.abgeordnetenwatch_api.licence` angibt. Sie dürfen sie nutzen, verändern und
weitergeben, auch kommerziell. Eine Quellenangabe ist nicht vorgeschrieben, aber erwünscht:
`Quelle: abgeordnetenwatch.de (https://www.abgeordnetenwatch.de) — Daten unter CC0 1.0.`

**Personenbezogene Daten.** Namen, Stimmen und Angaben zu Nebeneinkünften sind
personenbezogene Daten: CC0 verzichtet auf das Urheberrecht, nicht auf die Pflichten aus der
DSGVO. HTML-Felder wie `field_intro` können Material Dritter zitieren, und Website, Logo und
Marke sind nicht erfasst. Siehe [DATA_LICENSE.md](DATA_LICENSE.md).

## Exit-Codes

**Exit-Codes.** `0` Erfolg (auch `--help` und `--version`) · `1` API-Fehler, Netzwerk- oder
Parse-Fehler · `2` Aufruffehler (unbekannte Entität, falsche Option, falscher Filter oder
falsche ID) · `4` HTTP 404 (unbekannter Sammlungspfad).

**HTTP 500.** Eine fehlende ID, einen nicht akzeptierten Parameter und ein nicht sortierbares
Feld beantwortet die API mit HTTP 500, nicht mit 404 oder 400; die CLI gibt den Grund aus und
endet mit `1`. HTTP 429 und 503 werden automatisch wiederholt (`--max-retries`, Standard 2,
höchstens 10).

> **Bibliothek & Interna.** Den TypeScript-Client, die Request-Engine, Retries,
> Weiterleitungen und Fehlertypen beschreibt **[DEVELOPING.md](DEVELOPING.md)**.
