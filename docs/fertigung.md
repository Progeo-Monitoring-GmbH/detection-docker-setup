# SPEC: Digitales Fertigungsprotokoll dm (Werk) – Backend

Stand: 26.11.2026 · Gegenstück zur App „ProGeo manuSensor“, Bereich **Produktion**
(progeo-manusensor, `docs/superpowers/specs/2026-11-26-produktion-tab-design.md`).

Ersetzt das Papierformular „FP dm Breitband“ (Fertigungsprotokoll, 20 Sensoren je Blatt), das heute von
Hand ausgefüllt, gescannt und vom Make-Szenario „Produktionsprotokoll vom Scanner“ ausgewertet wird.

## 1. Überblick

| Endpunkt | Zweck | Status |
|---|---|---|
| `GET /v1/werk/auftraege/` | Auftragsliste | vorhanden (`helper/dm_orders.py`) |
| `GET /v1/werk/auftraege/<auftrag>/` | Auftrag mit Sensoren | vorhanden, erweitert (2.1) – **umgesetzt** |
| `PUT /v1/werk/auftraege/<auftrag>/eintraege/` | Messwerte je Sensor speichern (Entwurf) | **umgesetzt** (3.1) |
| `GET /v1/werk/auftraege/<auftrag>/eintraege/` | gespeicherte Einträge zurücklesen | **umgesetzt** (3.2) |
| `POST /v1/werk/auftraege/<auftrag>/blaetter/<blatt>/freigabe/` | Blatt freigeben = produziert | **umgesetzt** (3.3) |
| `POST /v1/werk/auftraege/<auftrag>/fortschritt/` | regelmäßige Fortschrittsmeldung | **umgesetzt** (3.4) |
| `GET /v1/werk/rollen/` · `POST /v1/werk/rollen/` · `GET`/`PATCH /v1/werk/rollen/<nummer>/` | Rollenregister Messband/Vorlauf | **umgesetzt** (3.5) |
| `GET /v1/werk/rollen/suche/?code=` · `POST /v1/werk/rollen/<nummer>/foto/` · `GET /v1/werk/rollen/fotos/<foto_id>/` | Rolle per Code, Etikettfotos | **umgesetzt** (3.5) |
| `GET /v1/werk/ich/` | Werk-Konto? Name, Kürzel | **umgesetzt** (1a) |
| `POST /v1/werk/benutzer/sync/` | Werk-Konten aus Airtable abgleichen (nur Staff, für einen Knopf der Staff-Seite) | **umgesetzt** (1a) |
| `POST /v1/werk/sensoren/` | Werkswerte R_Werk (Sammel-Import) | vorhanden, unverändert |

`<auftrag>` = lesbare Auftrags-ID (`PROD_dm-Breitband_7099_97`) oder Airtable-Record-ID, wie heute.

Gemeinsame Regeln (wie die vorhandenen manuSensor-Endpunkte):
- JSON über HTTPS, UTF-8, Bearer-Token (progeo-core-Login). **Nur Werk-Konten**: `user.is_staff or
  user.is_superuser or user in Gruppe "Werk"` (neue Prüfung `is_factory_user()`, gilt auch für die
  vorhandenen `/v1/werk/…`-Endpunkte), sonst `403 keine_berechtigung`. Siehe 1a.
- Fehler immer `{"fehler": <Code>, "meldung": <Text>[, "feld": <Feld>]}` (`ManuSensorError`).
- Zeitstempel ISO 8601 UTC (`"2026-11-26T09:41:12Z"`), Längen in Meter als Zahl mit max. 2 Nachkommastellen,
  Widerstände in ganzen Ohm.
- Projektnummer und Sensornummer wie bisher (`parse_project`, `normalize_sensor`: `"1130"` → `"001130"`).
- Speichern zuerst in der Datenbank („default“), Kopie nach Airtable danach per Celery (wie
  `push_to_airtable` der Baustellenmessungen). Ein langsames oder nicht erreichbares Airtable hält die App
  nie auf.

## 1a. Werk-Benutzer (Airtable „Ressourcen“ → Backend)

Die Fertigungsmitarbeiter stehen in Airtable „Ressourcen“ (dorthin verweist „dm Sensoren · Produziert
von“), haben aber bisher **keine Backend-Konten**. Sie bekommen eigene Konten mit Werk-Rechten:

- Neues Kontrollkästchen in „Ressourcen“: **„Werk-App“** (vom Base-Admin anzulegen). Angehakt = bekommt
  ein Backend-Konto.
- `manage.py sync_werk_users` (auch als Celery-Task, z. B. nachts und per Knopf auf der Staff-Seite):
  - je angehakter Ressource ein `User` (Benutzername aus der E-Mail-Adresse vor dem „@“, sonst aus dem
    Namen, z. B. `m.muster`; eindeutig gemacht), Gruppe **„Werk“**, nicht `is_staff` (kein Admin-Zugang);
  - Verknüpfung im neuen Modell `ProgeoWerkUser` (user ↔ `airtable_resource_id`, Name, Kürzel);
  - mit E-Mail-Adresse: Einladung zum Passwort-Setzen über den normalen Einladungslink
    (`login_links.send_login_link(…, "invite")`), nicht über die einmalige Migrations-Kampagne
    (`docs/migration_invites.md`) – die wird abgeschaltet und ihr Text passt nicht;
    ohne E-Mail: Konto ohne Passwort, ein Admin setzt es auf der Staff-Seite;
  - Häkchen entfernt → Konto deaktiviert (`is_active = False`), nicht gelöscht (Einträge bleiben zuordenbar).
- **Kürzel**: aus dem Namen (Vor- und Nachname, je erster Buchstabe, z. B. „MM“), überschreibbar in
  `ProgeoWerkUser`. Die App bekommt es über `GET /v1/werk/ich/` →
  `{"benutzer": "m.muster", "name": "Max Muster", "kuerzel": "MM", "werk": true}` (403 für alle anderen –
  daran erkennt die App, ob sie den Produktions-Bereich zeigt).
- **„Produziert von“** bei der Freigabe = `airtable_resource_id` des `erfasst_von`-Benutzers. Fehlt die
  Verknüpfung (z. B. ein Staff-Konto ohne Ressource), bleibt das Feld leer und es wird geloggt.

## 2. Begriffe und Abläufe

- **Blatt**: 20 Sensoren eines Auftrags (eine Kiste), nach Sensornummer sortiert, wie im PDF und im
  Airtable-Feld „QS: Nr.“. Blatt n = Sensoren an Position `20·(n−1)` … `20·n − 1`.
- **Eintrag**: die Messwerte eines Sensors (①, ②, ③, Metrierung, Rollen). Wird laufend gespeichert und
  gilt als **Entwurf**, bis sein Blatt freigegeben ist.
- **Freigabe**: Ein Blatt ist vollständig (alle Sensoren haben ①, ② und ③) und wird freigegeben.
  **Erst damit gelten seine Sensoren als produziert** (Produktionsstatus, Produktionsdatum, Bonus).
- **Ein Gerät je Auftrag**, mehrere Aufträge parallel (auf mehreren Geräten). Das Backend merkt sich das
  Gerät, das zuletzt an einem Auftrag gearbeitet hat, und meldet einen Wechsel (3.4), sperrt aber nicht.
- **Rollen**: Messband (Nennlänge 200 m) und Vorlaufband (1000 m, je Kabeltyp). Die Meter-Beschriftung
  des Vorlaufbands zählt **aufwärts**, jede Rolle beginnt bei einem anderen Wert. Eine angebrochene Rolle
  kann später an einem anderen Gerät/Auftrag weiterverwendet werden – deshalb liegt das Rollenregister im
  Backend.

### 2.1 Erweiterung von `GET /v1/werk/auftraege/<auftrag>/`

Jeder Sensor in `sensoren` bekommt zusätzlich:

```json
"blatt_nr": 1,                      // berechnet (Position / 20), nicht das Airtable-Feld "Blatt"
"sensor_record_id": "recZZZZZZZZZZZZZZ"   // = "id", nur zur Klarheit; "id" bleibt
```

und der Auftrag zusätzlich:

```json
"blaetter": 92,
"freigegebene_blaetter": [1, 2],
"eintraege_erfasst": 47,            // Sensoren mit ①②③ (aus der Datenbank, nicht gepuffert)
"produziert_papier": 120,           // in Airtable „Produziert“, ohne App-Eintrag (Papierprotokoll)
"geraet": {"id": "a1b2…", "benutzer": "m.muster", "zuletzt": "2026-11-26T09:41:12Z"}  // oder null
```

Diese Zusatzfelder kommen aus der Datenbank und werden **nicht** 60 s gepuffert.

### 2.2 Erweiterung von `GET /v1/werk/auftraege/`

Jeder Auftrag der Liste bekommt ebenfalls `eintraege_erfasst` (Datenbank, nicht gepuffert) und
`produziert_papier` (`helper/production.py` `augment_list`), damit die App den Fortschritt auch für
Sensoren zeigt, die noch auf Papier produziert wurden:

- Auftrag „Produziert“: alle verknüpften Sensoren ohne vollständigen App-Eintrag (keine Airtable-Abfrage).
- Sonst: die Sensoren mit Produktionsstatus „Produziert“ dieser Aufträge (eine Airtable-Abfrage je
  10 Aufträge, 60 s gepuffert) ohne vollständigen App-Eintrag.
- Antwortet Airtable dabei nicht, ist `produziert_papier` `null`; die Liste antwortet trotzdem.

## 3. Neue Endpunkte

### 3.1 `PUT /v1/werk/auftraege/<auftrag>/eintraege/` – Einträge speichern

Speichert bzw. aktualisiert die Einträge mehrerer Sensoren eines Auftrags (die App sendet gesammelt,
z. B. alle geänderten Zeilen). Idempotent: derselbe Inhalt erneut gesendet ändert nichts.

```json
{
  "geraet_id": "a1b2c3d4-…",                  // stabile ID der App-Installation
  "eintraege": [
    {
      "sensor_record_id": "recZZZZZZZZZZZZZZ",  // Pflicht: Zeile in "dm Sensoren"
      "sensor": "001130",                       // Pflicht, Kontrolle gegen sensor_record_id
      "r_platine": {"ohm": 99870, "status": "ok"},       // ①  status: "ok" | "offen"
      "r_aufgespult": {"ohm": 100120, "status": "ok"},   // ②
      "r_kurzschluss": {"ohm": 96, "status": "ok"},      // ③
      "metrierung_m": 412.00,                    // Metrierung Vorlaufende, darf null sein
      "metrierung_manuell": true,                // true = eingegeben, false = von der App weitergerechnet
      "messband_rolle": "MB-0141",               // darf null sein
      "vorlauf_rolle": "VL-0031",                // darf null sein
      "erfasst_von": "m.muster",                 // Benutzer, der die Werte eingegeben hat
      "erfasst_am": "2026-11-26T09:41:12Z",      // letzte Änderung der Zeile auf dem Gerät
      "quelle": "manuell"                        // "manuell" | "modul" (später per Bluetooth)
    }
  ]
}
```

Regeln:
- Ein Messwert ist `{"ohm": <int ≥ 0>, "status": "ok"}`, `{"ohm": null, "status": "offen"}` (Leitung
  offen) oder ganz `null` (noch nicht gemessen).
- **Neuere Änderung gewinnt**: Ein Eintrag mit älterem `erfasst_am` als dem gespeicherten wird ignoriert
  (Antwort `"veraltet"`), damit eine verspätete Wiederholung nichts überschreibt.
- `erfasst_von` muss ein existierendes, aktives **Werk-Konto** sein (`is_factory_user()`, 1a) (mehrere Personen am selben Tablet:
  zählt, wer die Werte eingegeben hat, nicht wer beim Senden angemeldet ist). Sonst 422 mit `feld`.
- Einträge zu einem bereits **freigegebenen** Blatt: erlaubt (Korrektur), werden gespeichert und als
  `"nach_freigabe_geaendert": true` markiert; die Airtable-Kopie wird aktualisiert.
- **R_Werk**: Ist ① `ok`, wird `ProgeoFactorySensor` (project_id = Projekt des Auftrags, sensor)
  angelegt/aktualisiert: `r_werk_ohm = ①`, `measured_at = erfasst_am`, `updated_by = erfasst_von`. Damit
  sieht die Baustellen-App den Werkswert sofort (wie heute über `POST /v1/werk/sensoren/`).
- Plausibilität wird **nicht** abgelehnt (Werte sind Messergebnisse); nur Formatfehler → 422.

Antwort `200`:
```json
{"ergebnisse": [{"sensor_record_id": "rec…", "ergebnis": "gespeichert"}],   // | "unveraendert" | "veraltet"
 "eintraege_erfasst": 48}
```
Fehler: `404 auftrag_unbekannt` · `422 ungueltig` (mit `feld`, z. B. `eintraege[3].r_platine.ohm`; dann
wird **nichts** gespeichert) · `409 sensor_nicht_im_auftrag` (sensor_record_id gehört nicht zum Auftrag; auch
dann wird nichts gespeichert). Höchstens 1000 Einträge je Anfrage; die Metrierung wird auf 2 Nachkommastellen gerundet.

### 3.2 `GET /v1/werk/auftraege/<auftrag>/eintraege/` – zurücklesen

Alle gespeicherten Einträge des Auftrags im Format von 3.1 plus `"gespeichert_am"` und
`"nach_freigabe_geaendert"`, als `{"eintraege": [...]}` nach Sensornummer. Für Neuinstallation/Gerätetausch: Die App führt lokale und gespeicherte
Einträge zusammen (neueres `erfasst_am` gewinnt).

### 3.3 `POST /v1/werk/auftraege/<auftrag>/blaetter/<blatt>/freigabe/` – Blatt freigeben

```json
{
  "geraet_id": "a1b2c3d4-…",
  "sensor_record_ids": ["rec…", "…"],        // die Sensoren des Blatts, wie die App sie sieht
  "freigegeben_von": "m.muster",
  "freigegeben_am": "2026-11-26T11:02:40Z",
  "auffaellig_bestaetigt": ["rec…"]          // Sensoren mit auffälligen Werten, bewusst freigegeben
}
```

Regeln:
- `sensor_record_ids` muss **genau** der Blattinhalt nach 2. sein, sonst `409 blatt_abweichend`
  (z. B. Sensorliste in Airtable inzwischen geändert) mit der aktuellen Liste in der Antwort
  (`"sensor_record_ids": [...]`). Dafür liest das Backend die Sensorliste frisch aus Airtable (nicht gepuffert).
- Blattnummer außerhalb des Auftrags: `404 blatt_unbekannt`.
- Alle Sensoren des Blatts brauchen gespeicherte ①, ② und ③ (Wert oder „offen“), sonst
  `422 blatt_unvollstaendig` mit den fehlenden Sensoren in `"sensor_record_ids"`. Die App sendet deshalb vorher 3.1.
- `auffaellig_bestaetigt` muss eine Teilmenge von `sensor_record_ids` sein (sonst 422).
- Wiederholte Freigabe desselben Blatts: `200`, gleiche Antwort (idempotent).
- Wirkung je Sensor (in Airtable „dm Sensoren“, per Celery):
  - `Produktionsstatus` = „Produziert“
  - `Produziert am` = `freigegeben_am`, `Produktionsdatum` = Datum von `freigegeben_am` (Europe/Berlin)
  - `Produziert von` = „Ressourcen“-Record des `erfasst_von`-Benutzers (`ProgeoWerkUser`, siehe 1a)
  - Messwertfelder (4.) aus dem Eintrag
- Ist danach **jedes** Blatt des Auftrags freigegeben, setzt das Backend „PA: dm“ `Produktionsstatus` =
  „Produziert“.

Antwort `200`: `{"blatt": 1, "freigegeben_am": "…", "sensoren": 20, "auftrag_fertig": false}`

### 3.4 `POST /v1/werk/auftraege/<auftrag>/fortschritt/` – regelmäßige Fortschrittsmeldung

Die App meldet, solange ein Auftrag geöffnet ist, **alle 2 Minuten** und **nach jeder fertigen Zeile**
(höchstens alle 15 s) den Stand. Leichtgewichtig, ohne Messwerte (die gehen über 3.1).

```json
{
  "geraet_id": "a1b2c3d4-…",
  "benutzer": "m.muster",
  "zeitpunkt": "2026-11-26T09:41:12Z",
  "aktives_blatt": 4,
  "erfasst": 67,                 // Sensoren mit ①②③ auf dem Gerät
  "ungesendet": 2,               // davon noch nicht per 3.1 bestätigt
  "freigegebene_blaetter": [1, 2, 3],
  "rollen": [
    {"nummer": "MB-0142", "typ": "messband", "rest_m": 52.5},
    {"nummer": "VL-0031", "typ": "vorlauf", "metrierung_m": 568.45}
  ]
}
```

Wirkung:
- Speichert den letzten Stand je Auftrag (Gerät, Benutzer, Zeit, Zahlen). Sichtbar in 2.1 (`geraet`) und
  auf der Staff-Seite; nach Airtable „PA: dm“ höchstens alle 5 Minuten je Auftrag (Felder in 4.).
- Aktualisiert den gemeldeten Stand der genannten Rollen (wie 3.5 `PATCH`).
- Meldet ein **anderes** Gerät als bisher für diesen Auftrag, antwortet das Backend trotzdem `200`, aber
  mit `"anderes_geraet": {"id": "…", "benutzer": "…", "zuletzt": "…"}`, damit die App warnen kann.

Antwort `200`: `{"ok": true, "anderes_geraet": null}`

### 3.5 Rollenregister

Rolle:
```json
{
  "nummer": "VL-0031",              // eindeutig, Freitext vom Etikett, max. 32 Zeichen
  "typ": "vorlauf",                 // "messband" | "vorlauf"
  "kabeltyp": "LiYY 2x0,14 UL",     // nur vorlauf
  "nennlaenge_m": 1000,             // messband 200, vorlauf 1000 (Standard), änderbar
  "start_metrierung_m": 120.00,     // nur vorlauf: Beschriftung am Rollenanfang
  "metrierung_m": 568.45,           // nur vorlauf: zuletzt gemeldete Metrierung
  "rest_m": 551.55,                 // messband: gemeldet; vorlauf: start + nenn − metrierung
  "leer": false,
  "zuletzt": {"geraet_id": "…", "benutzer": "m.muster", "auftrag_id": "PROD_…", "am": "…Z"}
}
```

- `GET /v1/werk/rollen/?typ=messband|vorlauf&leer=0` – Liste, zuletzt benutzte zuerst.
- `POST /v1/werk/rollen/` – neue Rolle (Body wie oben ohne `zuletzt`). Gibt es die Nummer schon:
  `409 rolle_vorhanden` mit der vorhandenen Rolle.
- `GET /v1/werk/rollen/<nummer>/` – eine Rolle (`404 rolle_unbekannt`).
- `PATCH /v1/werk/rollen/<nummer>/` – Stand melden/korrigieren (`rest_m` nur Messband, `metrierung_m` nur
  Vorlauf, `leer`) mit `geraet_id` und `am` (Pflicht), optional `benutzer`, `auftrag_id`; setzt `zuletzt`.
  Neuere Meldung gewinnt (`am`). Antwort: die Rolle plus `"ergebnis": "gespeichert" | "veraltet"`.
- `POST /v1/werk/rollen/` antwortet `201` mit der Rolle. Vorlauf braucht `start_metrierung_m` (sonst 422).
  Die Nummer darf weder `/` noch Backslash enthalten. Ein schon bekannter `code` gibt ebenfalls `409 rolle_vorhanden`.
- Meldet 3.4 eine unbekannte Rolle, wird sie übersprungen (nicht angelegt).
- `GET /v1/werk/rollen/suche/?code=<gescannter Wert>` – Rolle zu einem gescannten Etikett-Code
  (404 `rolle_unbekannt`, dann legt die App eine neue an).
- `POST /v1/werk/rollen/<nummer>/foto/` – Foto des Rollenetiketts als JSON (die App-Anmeldung über
  progeo-core sendet nur JSON): `{"foto_id": "<uuid der App>", "mime": "image/jpeg", "daten": "<Base64>"}`
  (JPEG/PNG, dekodiert max. 5 MB, sonst `413 zu_gross`; gespeichert auf max. 2000 px verkleinert).
  Idempotent über `foto_id`. Mehrere Fotos je Rolle erlaubt; Antwort `{"foto_url": "/v1/werk/rollen/fotos/<foto_id>/"}`
  (ein Pfad, nur mit Werk-Login abrufbar, weil `/media/` geschützt ist). Die Rolle liefert `"fotos": ["…"]`.
  Typ falsch oder Inhalt passt nicht zu `mime`: `422`; `foto_id` einer anderen Rolle: `409 foto_id_konflikt`.

Erfassung der Rolle in der App: **Foto des Etiketts ist Pflicht** bei einer neuen Rolle; hat das Etikett
einen Strich- oder QR-Code, wird er **gescannt** und als `code` (roher Inhalt) und `code_format`
(z. B. `CODE_128`, `QR_CODE`) mitgeschickt. Die Rollennummer ist dann der gescannte Inhalt, sonst Freitext.
Rolle zusätzlich: `"code": "…" | null, "code_format": "…" | null, "fotos": [...]`.

## 4. Datenmodell und Airtable

Datenbank („default“, wie `ProgeoFactorySensor`):
- `ProgeoProductionEntry` – je `sensor_record_id` (unique): Auftrag (ID + Record-ID), Projekt, Sensor,
  die drei Messwerte (ohm + status), Metrierung (+ manuell), Rollen, erfasst_von (FK User), erfasst_am,
  quelle, geraet_id, gespeichert_am, nach_freigabe_geaendert, airtable_synced_at.
- `ProgeoProductionSheet` – (auftrag_record_id, blatt) unique: sensor_record_ids, freigegeben_von,
  freigegeben_am, auffaellig_bestaetigt.
- `ProgeoProductionProgress` – je Auftrag der letzte Stand aus 3.4.
- `ProgeoRoll` – Rollenregister aus 3.5 (mit `code`, `code_format`), `ProgeoRollPhoto` – Fotos.
- `ProgeoWerkUser` – Backend-Benutzer ↔ Airtable-Ressource, Name, Kürzel (1a).

Airtable – **neue Felder, angelegt am 26.11.2026** (geprüft: keine Automation und kein Make-Szenario liest
alle Felder oder lauscht auf „Last Modified“ von „PA: dm“). Die Namen stehen in
`production.AIRTABLE_SENSOR_FIELDS`/`AIRTABLE_ORDER_FIELDS` und werden nur geschrieben, nicht von `dm_orders`
gelesen – ein noch fehlendes Feld bricht so die Auftragsliste nicht. Bis die Felder existieren, schlägt die
Kopie fehl und wird stündlich wiederholt (`push_pending_production`). Dazu in „Ressourcen“ das
Kontrollkästchen **„Werk-App“** (1a).

„dm Sensoren“:
| Feld | Typ |
|---|---|
| R Platine [Ω] | Zahl (ganz), leer = offen/nicht gemessen |
| R aufgespult [Ω] | Zahl |
| R kurzgeschlossen [Ω] | Zahl |
| Messung offen | Mehrfachauswahl: ①, ②, ③ |
| Metrierung Vorlaufende [m] | Zahl, 2 Nachkommastellen |
| Messband-Rolle | Text |
| Vorlauf-Rolle | Text |
| Erfasst von | Text (Benutzername) |
| Protokoll-Quelle | Einfachauswahl: App, Scan |

Vorhandene Felder, die die Freigabe setzt: Produktionsstatus, Produziert am, Produktionsdatum, Produziert von.

„PA: dm“:
| Feld | Typ |
|---|---|
| App-Fortschritt | Text, z. B. „67 / 1834 · Blatt 4 · m.muster · 26.11. 10:41“ |
| Freigegebene Blätter | Zahl |

Make: Für Blätter mit Protokoll-Quelle „App“ entfällt „Produktionsprotokoll vom Scanner“.

### 4.1 QS-Prüfung und Staff-Seite `/staff/production/` (`helper/production_overview.py`)

Die QS-Prüfung der App-Protokolle macht das Backend (die „Automatik“ aus der Feldbeschreibung von
„QS-Prüfung“), Staff entscheidet den Rest:
- Werte wie in der App (`SheetRules.kt` in progeo-manusensor – beide gleich halten): ① und ② 80–120 kΩ,
  sonst **Warnung**; ③ unter 150 Ω, sonst **Fehler**; „offen“ ist ein Fehler.
- Bei der **Freigabe** eines Blatts: Sensoren nur mit guten Werten → „QS-Prüfung“ = **OK**, sonst
  **Prüfen**. Ändert sich ein freigegebener Sensor, wird neu geprüft – ein **manuelles OK bleibt**, eine
  manuelle Nacharbeit wird nach neuer Messung wieder automatisch (Nacharbeit erledigt).
- Staff entscheidet auf `/staff/production/` **OK** oder **Nacharbeit** (`qs_manuell`, „QS manuell“ ✓),
  „Prüfen“ nimmt die Entscheidung zurück. Kopie nach „dm Sensoren“ wie ein geänderter Eintrag.
- Entwürfe (Blatt nicht freigegeben) haben keine QS-Prüfung (409 `nicht_freigegeben`).

Endpunkte (nur Staff/Superuser):
- `GET /v1/werk/produktion/?tage=14&auftrag=<record id>` – Kennzahlen, Messband-/Vorlauf-Meter pro Tag
  (vollständige Einträge nach `erfasst_am`, Längen aus „dm Sensoren“ beim Speichern in
  `laenge_m`/`vorlauf_m`), Fehler und Warnungen mit QS-Stand, Aufträge, Rollen mit Anzahl Sensoren.
- `POST /v1/werk/produktion/qs/` `{"sensor_record_ids": [...], "qs": "OK" | "Nacharbeit" | "Prüfen"}`.
- Sensoren mit **Papierprotokoll** (in Airtable „Produziert“, nicht in der App) zählen bei Fortschritt und
  Metern pro Tag mit (nach „Produziert am“), live aus Airtable gelesen (`dm_orders.produced_sensors`,
  `load_order`, kurz gecacht). Jeder Sensor zählt einmal. Die Seite listet außerdem alle Aufträge „zu
  Produzieren“. Ihre QS-Prüfung bleibt auf der Airtable-Seite „QS offen“. Antwortet Airtable nicht, zählen
  nur die App-Einträge (`airtable_fehler: true`, Hinweis auf der Seite).

Airtable „dm Sensoren“ (vorhandene Felder): **QS-Prüfung** (OK / Nacharbeit / Prüfen), **QS manuell**.

## 5. Tests (pytest, wie `tests/test_dm_orders.py` gegen ein Fake-Airtable)

- 3.1: Speichern, unverändert, veraltet, 422 mit Feld (nichts gespeichert), 409 fremder Sensor, R_Werk
  aus ① in `ProgeoFactorySensor`, `erfasst_von` ≠ angemeldeter Benutzer.
- 3.3: unvollständig (422), abweichend (409), idempotent, Airtable-Felder je Sensor, Auftrag fertig.
- 3.4: Stand gespeichert, anderes Gerät gemeldet, Airtable höchstens alle 5 min.
- 3.5: anlegen, doppelt (409), PATCH neuere gewinnt, Rest Vorlauf berechnet.
- Rollenfoto: Upload, zu groß (413), falscher Typ (422); Suche per Code.
- `sync_werk_users`: anlegen, Gruppe „Werk“, Häkchen weg → deaktiviert, Kürzel; `GET /v1/werk/ich/`.
- Weder Staff noch Gruppe „Werk“: 403 auf allen `/v1/werk/…`-Endpunkten.

## 6. Offen

1. QS-Prüfung für App-Protokolle: im Backend (4.1). Offen nur, ob das Make-Szenario App-Protokolle
   überspringen muss, damit es die QS-Prüfung nicht überschreibt.
2. Welche Codes die Rollenetiketten der Lieferanten tragen (das Backend speichert den rohen Inhalt).
