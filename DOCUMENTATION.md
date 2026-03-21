# ABAP MCP Server v2 — Dokumentation

> Standalone MCP Server für agentives ABAP-Development.  
> Vollständige Tool-Parität mit vscode_abap_remote_fs MCP + Write-Erweiterungen.

---

## Inhaltsverzeichnis

1. [Überblick](#überblick)
2. [Architektur](#architektur)
3. [Installation & Setup](#installation--setup)
4. [Konfiguration (.env)](#konfiguration-env)
5. [MCP Client Integration](#mcp-client-integration)
6. [Tool-Referenz](#tool-referenz)
   - [SEARCH — Objektsuche](#search--objektsuche)
   - [READ — Lesen](#read--lesen)
   - [WRITE — Schreiben](#write--schreiben)
   - [CREATE — Anlegen](#create--anlegen)
   - [DELETE — Löschen](#delete--löschen)
   - [TEST — Unit Tests](#test--unit-tests)
   - [QUALITY — Codequalität](#quality--codequalität)
   - [DIAGNOSTICS — Diagnose](#diagnostics--diagnose)
   - [TRANSPORT — Transporte](#transport--transporte)
   - [ABAPGIT — Git-Integration](#abapgit--git-integration)
   - [QUERY — SQL-Abfragen](#query--sql-abfragen)
   - [DOCUMENTATION — SAP-Dokumentation](#documentation--sap-dokumentation)
7. [MCP Prompts](#mcp-prompts)
   - [abap_develop — Entwicklungsworkflow](#abap_develop--entwicklungsworkflow)
8. [ADT Write-Workflow](#adt-write-workflow)
9. [Sicherheitskonzept](#sicherheitskonzept)
10. [ADT Objekt-URL Referenz](#adt-objekt-url-referenz)
11. [Fehlerbehebung](#fehlerbehebung)
12. [Bekannte Einschränkungen](#bekannte-einschränkungen)

---

## Überblick

Der ABAP MCP Server ermöglicht KI-Assistenten (Claude, GitHub Copilot, Cursor usw.) direkten
Zugriff auf ein SAP ABAP-System über die ADT REST API — ohne VS Code als Brücke.

**47 Tools** in 12 Gruppen + 2 Meta-Tools + 1 MCP Prompt decken den kompletten ABAP-Entwicklungsworkflow ab:

| Gruppe | Anzahl Tools | Beschreibung |
|--------|-------------|--------------|
| SEARCH | 2 | Objektsuche mit Wildcards, Quellcode-Volltextsuche |
| READ | 10 | Quellcode, Metadaten, Where-Used, Code Completion, Definitionen, Revisionen, DDIC, Tabellen, Fix-Vorschläge, Kontext-Analyse |
| WRITE | 4 | Quellcode schreiben, aktivieren, Massen-Aktivierung, formatieren |
| CREATE | 7 | Programme, Klassen, Interfaces, FuGr, CDS, Tabellen, Messages |
| DELETE | 1 | Objekte löschen |
| TEST | 2 | Unit Tests ausführen, Test-Includes erstellen |
| QUALITY | 4 | Syntaxcheck, ATC-Prüfungen, DDIC-Feldvalidierung, Clean ABAP Code-Review |
| DIAGNOSTICS | 4 | Short Dumps, Performance Traces |
| TRANSPORT | 3 | Transport-Infos, Transport-Inhalte, Transport erstellen |
| ABAPGIT | 2 | Repos auflisten, Pull ausführen |
| QUERY | 3 | SELECT-Statements, inaktive Objekte, ABAP-Snippets ausführen |
| DOCUMENTATION | 5 | ABAP-Keyword-Doku, Klassen-Doku, Modul-Best-Practices, Clean ABAP, ABAP-Syntax |
| META | 2 | Tool-Finder und Tool-Übersicht für dynamische Tool-Registrierung |
| PROMPTS | 1 | `abap_develop` — Intelligenter ABAP-Entwicklungsworkflow |

> **Token-Optimierung:** Mit `DEFER_TOOLS=true` (Default) werden initial nur 10 Kern-Tools geladen.
> Weitere Tools werden on-demand über `find_tools` aktiviert — das spart ~75-80% Tokens pro `tools/list`-Aufruf.

---

## Architektur

```
Claude / MCP Client
       │  stdio (MCP Protocol)
       ▼
┌─────────────────────────────┐
│   ABAP MCP Server (Node.js) │
│   src/index.ts              │
│                             │
│   ┌─────────────────────┐   │
│   │  abap-adt-api       │   │  ← TypeScript-Bibliothek
│   │  (ADTClient)        │   │    von Marcello Urbani
│   └──────────┬──────────┘   │
└──────────────┼──────────────┘
               │  HTTPS / ADT REST API
               ▼
┌──────────────────────────────┐
│   SAP NetWeaver / S/4HANA    │
│   /sap/bc/adt/* (SICF)       │
└──────────────────────────────┘
```

Der Server läuft lokal und kommuniziert über **stdio** mit dem MCP-Client.
Die SAP-Verbindung wird einmalig beim Start aufgebaut (Lazy Init) und dann wiederverwendet.

---

## Installation & Setup

### Voraussetzungen

- **Node.js** >= 20
- **SAP-System** mit aktiviertem ADT-Service (Transaktion SICF → `/sap/bc/adt` aktivieren)
- **SAP-User** mit Berechtigung `S_ADT_RES` (ADT-Zugriff)
- Für Write-Operationen: **NetWeaver >= 7.51** (oder [abapfs_extensions](https://github.com/marcellourbani/abapfs_extensions) auf dem System installiert)

### Installation

```bash
git clone <REPOSITORY_URL>
cd abap-mcp-server
npm install
npm run build
```

### SICF-Aktivierung (SAP-Seite)

Transaktion SICF ausführen und folgende Services aktivieren:

```
/sap/bc/adt/           (ADT Root — Pflicht)
/sap/bc/adt/programs/  (Programme)
/sap/bc/adt/oo/        (Klassen, Interfaces)
/sap/bc/adt/ddic/      (DDIC-Objekte)
/sap/bc/adt/atc/       (ATC — optional)
/sap/bc/adt/runtime/   (Dumps, Traces — optional)
```

---

## Konfiguration (.env)

```bash
cp .env.example .env
```

| Variable | Pflicht | Default | Beschreibung |
|----------|---------|---------|--------------|
| `SAP_URL` | ✓ | — | System-URL, z.B. `https://dev-system:8000` |
| `SAP_USER` | ✓ | — | Benutzername |
| `SAP_PASSWORD` | ✓ | — | Passwort |
| `SAP_CLIENT` | | `100` | Mandant |
| `SAP_LANGUAGE` | | `EN` | Anmeldesprache |
| `ALLOW_WRITE` | | `false` | Write-Tools aktivieren. **Nur auf DEV!** |
| `ALLOW_DELETE` | | `false` | Löschen aktivieren. Zusätzlich zu ALLOW_WRITE |
| `ALLOW_EXECUTE` | | `false` | `execute_abap_snippet` aktivieren. Zusätzlich zu ALLOW_WRITE |
| `BLOCKED_PACKAGES` | | `SAP,SHD` | Kommaliste gesperrter Paket-Präfixe |
| `DEFAULT_TRANSPORT` | | — | Standard-Transport wenn nicht angegeben |
| `SYNTAX_CHECK_BEFORE_ACTIVATE` | | `true` | Syntaxcheck vor Aktivierung erzwingen |
| `MAX_DUMPS` | | `20` | Maximale Anzahl Short Dumps |
| `SAP_ABAP_VERSION` | | `latest` | ABAP-Version für help.sap.com Dokumentation (z.B. `latest`, `758`, `754`) |
| `SAP_ALLOW_UNAUTHORIZED` | | `false` | Self-signed SSL-Zertifikate akzeptieren (nur DEV!) |
| `DEFER_TOOLS` | | `true` | Tool-Deferred-Modus: initial nur Kern-Tools laden |

### Beispiel .env (Entwicklungssystem)

```env
SAP_URL=https://<SAP_SYSTEM>:<PORT>
SAP_USER=<USERNAME>
SAP_PASSWORD=<PASSWORD>
SAP_CLIENT=<CLIENT>
SAP_LANGUAGE=<LANGUAGE>
ALLOW_WRITE=true
ALLOW_DELETE=false
BLOCKED_PACKAGES=SAP,SHD,SMOD
DEFAULT_TRANSPORT=<TRANSPORT_ID>
MAX_DUMPS=50
```

> ⚠️ **Sicherheitshinweis**: Die `.env`-Datei enthält Klartext-Passwörter.  
> Datei in `.gitignore` aufnehmen und nicht committen!

---

## MCP Client Integration

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "abap": {
      "command": "node",
      "args": ["/pfad/zum/abap-mcp-server/dist/index.js"],
      "env": {
        "SAP_URL": "https://<SAP_SYSTEM>:<PORT>",
        "SAP_USER": "<USERNAME>",
        "SAP_PASSWORD": "<PASSWORD>",
        "SAP_CLIENT": "<CLIENT>",
        "ALLOW_WRITE": "true"
      }
    }
  }
}
```

### Claude Code (`.claude/mcp.json` oder `mcp.json`)

```json
{
  "mcpServers": {
    "abap": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/pfad/zum/abap-mcp-server"
    }
  }
}
```

### Cursor / Windsurf (`cursor_mcp_config.json`)

```json
{
  "mcpServers": {
    "abap": {
      "command": "node",
      "args": ["<path/to/abap-mcp-server>/dist/index.js"]
    }
  }
}
```

---

## Tool-Referenz

---

### META — Tool Discovery

#### `find_tools`

Findet und aktiviert ABAP-Tools nach Suchbegriff oder Kategorie. Wird nur im Deferred-Modus (`DEFER_TOOLS=true`) benötigt — dann werden initial nur Kern-Tools geladen und weitere Tools on-demand über dieses Meta-Tool aktiviert.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `query` | string | | Suchmuster für Tool-Namen/Beschreibungen |
| `category` | string | | Kategorie: `SEARCH`, `READ`, `WRITE`, `CREATE`, `DELETE`, `TEST`, `QUALITY`, `DIAGNOSTICS`, `TRANSPORT`, `ABAPGIT`, `QUERY`, `DOCUMENTATION` |
| `enable` | boolean | | Tools aktivieren/deaktivieren (Default: true) |

**Beispiele:**
```
Alle Create-Tools aktivieren
→ find_tools(category="CREATE")

Tools zum Thema "test" finden
→ find_tools(query="test")

Kategorieübersicht anzeigen
→ find_tools()
```

**Kern-Tools (immer verfügbar):** `search_abap_objects`, `read_abap_source`, `write_abap_source`, `get_object_info`, `where_used`, `analyze_abap_context`, `search_abap_syntax`, `validate_ddic_references`, `find_tools`, `list_tools`

---

#### `list_tools`

Gibt eine kompakte Übersicht aller verfügbaren Tools mit Kurzbeschreibungen zurück, gruppiert nach Kategorie. Zeigt welche Tools aktiv (core/enabled) vs. deferred sind. Aktiviert **keine** Tools — nutzt man nur zur Orientierung.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `category` | string | | Filter nach Kategorie: `SEARCH`, `READ`, `WRITE`, `CREATE`, `DELETE`, `TEST`, `QUALITY`, `DIAGNOSTICS`, `TRANSPORT`, `ABAPGIT`, `QUERY`, `DOCUMENTATION`. Leer = alle. |

**Beispiele:**
```
Alle verfügbaren Tools anzeigen
→ list_tools()

Nur READ-Tools anzeigen
→ list_tools(category="READ")
```

---

### SEARCH — Objektsuche

#### `search_abap_objects`

Sucht ABAP-Objekte im System per Namensmuster. Wildcards (`*`) werden unterstützt.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `query` | string | ✓ | Suchmuster, z.B. `ZCL_*SERVICE*` |
| `maxResults` | number | | Maximale Ergebnisse (1–100, Default: 20) |
| `objectType` | string | | ADT-Typ-Filter (s. Tabelle unten) |

**Unterstützte Objekttypen (`objectType`):**

| Wert | Beschreibung |
|------|-------------|
| `PROG/P` | Programme (Reports) |
| `CLAS/OC` | ABAP-Klassen |
| `INTF/OI` | ABAP-Interfaces |
| `FUGR/F` | Funktionsgruppen |
| `DDLS/DF` | CDS Views (DDL Source) |
| `TABL/DT` | Transparente Tabellen |
| `DOMA/DE` | Domänen |
| `DTEL/DE` | Datenelemente |
| `MSAG/E` | Nachrichtenklassen |
| `SICF/SC` | ICF-Services |

**Beispiel:**
```
Suche alle Klassen die "BILLING" im Namen haben
→ search_abap_objects(query="*BILLING*", objectType="CLAS/OC")
```

---

#### `search_source_code`

Volltextsuche über allen ABAP-Quellcode im System. Findet Objekte, deren Quelltext den angegebenen Text enthält. Benötigt NW 7.31+ (ADT Text-Search-Service).

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `searchString` | string | ✓ | Suchtext, z.B. `Hallo`, `READ TABLE`, `BAPI_USER_GET_DETAIL` |
| `maxResults` | number | | Maximale Ergebnisse (1–200, Default: 50) |

**Beispiel:**
```
Finde alle Programme die "Hallo" ausgeben
→ search_source_code(searchString="Hallo")

Finde alle Stellen wo BAPI_USER_GET_DETAIL verwendet wird
→ search_source_code(searchString="BAPI_USER_GET_DETAIL")
```

**Hinweis:** Nutzt den ADT-Endpoint `/sap/bc/adt/repository/informationsystem/textsearch`. Erfordert ggf. die Business-Funktion `SRIS_SOURCE_SEARCH` auf dem SAP-System.

---

### READ — Lesen

#### `read_abap_source`

Liest den vollständigen Quellcode eines ABAP-Objekts. Mit `includeRelated=true` werden alle zugehörigen Objekte automatisch mitgelesen: Klassen-Includes (Definitionen, Implementierungen, Makros, Test-Klassen), Programm-Includes (INCLUDE-Statements aufgelöst), Funktionsgruppen-Includes.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `objectUrl` | string | ✓ | ADT-URL des Objekts |
| `includeRelated` | boolean | | Alle zugehörigen Objekte mitlesen (Default: false). Empfohlen um den vollen Kontext zu verstehen. |

**Beispiel:**
```
Lies den Quellcode von ZCL_BILLING_SERVICE mit allen Includes
→ read_abap_source(objectUrl="/sap/bc/adt/oo/classes/zcl_billing_service", includeRelated=true)
```

---

#### `get_object_info`

Liest die Struktur und Metadaten eines Objekts (Methoden, Attribute, Includes, DDIC-Felder).

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `objectUrl` | string | ✓ | ADT-URL des Objekts |

---

#### `where_used`

Findet alle Stellen im System wo ein Objekt verwendet wird.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `objectUrl` | string | ✓ | ADT-URL des gesuchten Objekts |
| `maxResults` | number | | Max. Ergebnisse (1–200, Default: 50) |

---

#### `get_code_completion`

Holt Code-Vervollständigungsvorschläge vom SAP-System für eine Cursor-Position.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `objectUrl` | string | ✓ | ADT-URL (Kontext) |
| `source` | string | ✓ | Aktueller Quellcode |
| `line` | number | ✓ | Cursor-Zeile (1-basiert) |
| `column` | number | ✓ | Cursor-Spalte (0-basiert) |

---

#### `find_definition`

Navigiert zur Definition eines Tokens (Variable, Methode, Klasse usw.) im Quellcode. Gibt URI, Zeile und Spalte der Definition zurück.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `objectUrl` | string | ✓ | ADT-URL des Quellobjekts (Kontext) |
| `source` | string | ✓ | Aktueller Quellcode |
| `line` | number | ✓ | Token-Zeile (1-basiert) |
| `startColumn` | number | ✓ | Token Start-Spalte (0-basiert) |
| `endColumn` | number | ✓ | Token End-Spalte (0-basiert) |
| `mainProgram` | string | | Hauptprogramm (für Includes) |

**Beispiel:**
```
Definition einer Methode finden
→ find_definition(objectUrl="/sap/bc/adt/oo/classes/zcl_foo", source="...", line=10, startColumn=5, endColumn=15)
```

---

#### `get_revisions`

Liest die Versionshistorie eines ABAP-Objekts. Gibt alle gespeicherten Revisionen mit Datum, Autor und Transportauftrag zurück.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `objectUrl` | string | ✓ | ADT-URL des Objekts |

**Beispiel:**
```
Versionshistorie einer Klasse abrufen
→ get_revisions(objectUrl="/sap/bc/adt/oo/classes/zcl_billing_service")
```

---

#### `get_ddic_element`

Liest detaillierte DDIC-Informationen für eine Tabelle, View, Datenelement oder Domäne. Gibt Felder, Typen, Annotationen und Assoziationen zurück.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `path` | string | ✓ | DDIC-Pfad, z.B. Tabellenname oder CDS-View-Name |

**Beispiel:**
```
Felder der Tabelle T001 anzeigen
→ get_ddic_element(path="T001")
```

---

#### `get_table_contents`

Liest Tabelleninhalte direkt aus einer DDIC-Tabelle. Gibt die Daten als JSON zurück.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `tableName` | string | ✓ | Name der DDIC-Tabelle |
| `maxRows` | number | | Max. Anzahl Zeilen (1–1000, Default: 100) |

**Beispiel:**
```
Erste 10 Buchungskreise lesen
→ get_table_contents(tableName="T001", maxRows=10)
```

---

#### `get_fix_proposals`

Holt Quick-Fix-Vorschläge für eine bestimmte Position im Quellcode (z.B. fehlende Methode implementieren, Variable deklarieren).

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `objectUrl` | string | ✓ | ADT-URL des Objekts |
| `source` | string | ✓ | Aktueller Quellcode |
| `line` | number | ✓ | Fehler-Zeile (1-basiert) |
| `column` | number | ✓ | Fehler-Spalte (0-basiert) |

**Beispiel:**
```
Fix-Vorschläge für Zeile 15 abrufen
→ get_fix_proposals(objectUrl="/sap/bc/adt/oo/classes/zcl_foo", source="...", line=15, column=0)
```

---

#### `analyze_abap_context`

Analysiert den vollständigen Kontext eines ABAP-Objekts. Liest Quellcode inkl. aller Includes, erkennt referenzierte Funktionsbausteine, Klassen und Interfaces per Regex, ruft deren Metadaten ab und liefert einen strukturierten Kontext-Report. **Empfohlener Einstiegspunkt** vor jeder Code-Änderung.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `objectUrl` | string | ✓ | ADT-URL des Haupt-Objekts |
| `depth` | enum | | `shallow` = nur Hauptquelle + direkte Includes; `deep` = rekursiv alle Referenzen (Default: `deep`) |

**Rückgabe:** Strukturierter Report mit folgenden Abschnitten:

```
══ KONTEXT-ANALYSE: <OBJEKTNAME> ══

📋 PROGRAMMSTRUKTUR
  Typ, Paket, Anzahl Includes, Methoden, Attribute

📄 QUELLCODE (Main + Includes)
  Vollständiger Quellcode aller Abschnitte

🔗 REFERENZIERTE OBJEKTE
  Funktionsbausteine (mit Beschreibung)
  Klassen/Interfaces (mit Methoden-Liste)
  Statische Aufrufe

⚡ ZUSAMMENFASSUNG
  Anzahl Includes, FMs, Klassen
```

**Erkannte Referenz-Patterns:**
- `CALL FUNCTION 'FM_NAME'` → Funktionsbausteine
- `CREATE OBJECT ... TYPE classname` / `NEW classname(` → Klassen
- `CLASSNAME=>METHOD` → Statische Aufrufe
- `TYPE REF TO interface` → Interfaces

**Beispiel:**
```
Vollständigen Kontext eines Reports analysieren
→ analyze_abap_context(objectUrl="/sap/bc/adt/programs/programs/zrybak_test", depth="deep")
```

> **Hinweis:** Dieses Tool ist ein Kern-Tool und immer verfügbar (auch im Deferred-Modus). Es wird vom MCP Prompt `abap_develop` als erster Schritt im Entwicklungsworkflow verwendet.

---

### WRITE — Schreiben

> ⚠️ Alle Write-Tools erfordern `ALLOW_WRITE=true` in der `.env`.

#### `write_abap_source`

Schreibt Quellcode in ein bestehendes Objekt und führt den vollständigen ADT-Workflow aus:

```
🔒 lock → ✏️ write → 🔍 syntax check → 🚀 activate → 🔓 unlock
```

Bei Syntaxfehlern wird **nicht aktiviert** und der Lock automatisch freigegeben.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `objectUrl` | string | ✓ | ADT-URL (ohne `/source/main`) |
| `source` | string | | Vollständiger ABAP-Quellcode — nur für kurze Snippets (< 20 Zeilen). Für größere Programme `sourcePath` verwenden. |
| `sourcePath` | string | | **BEVORZUGT:** Pfad zu einer lokalen Datei mit dem ABAP-Quellcode. Schneller, günstiger und vermeidet JSON-Escaping-Probleme. |
| `transport` | string | | Transportauftrag |
| `activateAfterWrite` | boolean | | Aktivieren nach dem Schreiben (Default: true) |
| `skipSyntaxCheck` | boolean | | Syntaxcheck überspringen (Default: false) |
| `mainProgram` | string | | Hauptprogramm für Syntaxcheck von Includes — Name (z.B. ZRYBAK_AI_TEST) oder ADT-URL |

> **Hinweis:** Entweder `source` oder `sourcePath` muss angegeben werden.

---

#### `activate_abap_object`

Aktiviert ein bereits gespeichertes Objekt.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `objectUrl` | string | ✓ | ADT-URL |
| `objectName` | string | ✓ | Objektname (z.B. `ZCL_FOO`) |

---

#### `mass_activate`

Aktiviert mehrere Objekte in einem Schritt. Max. 50 Objekte pro Aufruf.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `objects` | array | ✓ | Array mit `{objectUrl, objectName}` |

---

#### `pretty_print`

Formatiert ABAP-Quellcode über den SAP Pretty Printer. **Speichert nichts**, liefert nur formatierten Code zurück.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `source` | string | ✓ | Zu formatierender Quellcode |
| `objectUrl` | string | | ADT-URL für Kontext (optional) |

> **Hinweis:** Einrückung und Keyword-Schreibweise werden serverseitig konfiguriert (SE38 → Einstellungen).

---

### CREATE — Anlegen

> ⚠️ Alle Create-Tools erfordern `ALLOW_WRITE=true`.  
> Objektnamen müssen im Customer-Namespace liegen (Z/Y-Prefix).

#### `create_abap_program`

Legt ein neues ABAP-Programm an. Name muss mit `Z` oder `Y` beginnen.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `name` | string | ✓ | Programmname (max. 30 Zeichen) |
| `description` | string | ✓ | Kurztext (max. 40 Zeichen) |
| `devClass` | string | ✓ | Paket (z.B. `ZLOCAL` oder `$TMP`) |
| `transport` | string | | Leer für lokale Objekte ($TMP) |

---

#### `create_abap_class`

Legt eine neue Klasse an. Name muss mit `ZCL_` oder `YCL_` beginnen.

**Zusätzlicher Parameter:**

| Parameter | Typ | Beschreibung |
|-----------|-----|-------------|
| `superClass` | string | Superklasse, z.B. `CL_ABAP_UNIT_ASSERT` |

---

#### `create_abap_interface`

Legt ein neues Interface an. Name muss mit `ZIF_` oder `YIF_` beginnen.

---

#### `create_function_group`

Legt eine neue Funktionsgruppe an. Name muss mit `Z` oder `Y` beginnen (max. 26 Zeichen).

---

#### `create_cds_view`

Legt eine neue CDS View (DDL Source) an. Name muss mit `Z` oder `Y` beginnen.

**Hinweis:** Nach dem Anlegen muss die CDS View über `write_abap_source` mit der eigentlichen  
DDL-Definition gefüllt werden.

---

#### `create_database_table`

Legt eine neue transparente Tabelle (TABL) an. Name muss mit `Z` oder `Y` beginnen (max. 16 Zeichen).

---

#### `create_message_class`

Legt eine neue Nachrichtenklasse (MSAG) an. Name muss mit `Z` oder `Y` beginnen.

---

### DELETE — Löschen

> ⛔ **Achtung**: Löschen ist **nicht rückgängig** machbar!  
> Erfordert sowohl `ALLOW_WRITE=true` als auch `ALLOW_DELETE=true`.

#### `delete_abap_object`

Löscht ein ABAP-Objekt dauerhaft aus dem System.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `objectUrl` | string | ✓ | ADT-URL des Objekts |
| `objectName` | string | ✓ | Name (zur Bestätigung) |
| `transport` | string | | Transportauftrag |

---

### TEST — Unit Tests

#### `run_unit_tests`

Führt ABAP Unit Tests für eine Klasse oder ein Programm aus.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `objectUrl` | string | ✓ | ADT-URL der Klasse oder des Programms |

**Rückgabe:** Liste der Test-Ergebnisse mit Pass/Fail-Status, Fehlermeldungen und Stack Traces.

---

#### `create_test_include`

Erstellt ein Test-Include (CCAU) für eine vorhandene Klasse und generiert die Grundstruktur für ABAP Unit Tests.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `classUrl` | string | ✓ | ADT-URL der Klasse |

**Generierter Code-Rahmen:**
```abap
CLASS ltcl_<classname> DEFINITION FINAL FOR TESTING
  DURATION SHORT
  RISK LEVEL HARMLESS.
  PRIVATE SECTION.
    METHODS: test_<method> FOR TESTING.
ENDCLASS.

CLASS ltcl_<classname> IMPLEMENTATION.
  METHOD test_<method>.
    " Test-Code hier
  ENDMETHOD.
ENDCLASS.
```

---

### QUALITY — Codequalität

#### `run_syntax_check`

Führt einen ABAP-Syntaxcheck durch **ohne zu speichern**.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `objectUrl` | string | ✓ | ADT-URL (Kontext) |
| `source` | string | ✓ | Zu prüfender Quellcode |
| `mainProgram` | string | | Hauptprogramm (für Includes) |

**Rückgabe:** Liste von Meldungen mit Severity (`E`=Error, `W`=Warning, `I`=Info), Zeilennummer und Text.

---

#### `run_atc_check`

Startet eine ATC-Prüfung (ABAP Test Cockpit) für ein Objekt.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `objectUrl` | string | ✓ | ADT-URL des Objekts |
| `checkVariant` | string | | Prüfvariante (Default: `DEFAULT`) |

**Rückgabe:** Liste der Befunde mit Priorität (1=kritisch, 2=wichtig, 3=Hinweis), Kategorie, Beschreibung und Position.

---

#### `validate_ddic_references`

Analysiert ABAP-Quellcode statisch und prüft alle referenzierten Tabellenfelder gegen die DDIC-Metadaten. Findet ungültige Feldnamen **vor** dem Schreiben des Codes und verhindert so Trial-and-Error-Zyklen mit "No component exists"-Syntaxfehlern.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `source` | string | ✓ | ABAP-Quellcode der zu prüfenden Programmlogik |

**Erkannte Patterns:**

- `TYPE tablename-fieldname` — Feldtypreferenzen
- `LIKE tablename-fieldname` — Feldähnlichkeitsreferenzen

**Filter & Exceptions:**

Die Validierung ignoriert automatisch:
- Lokale Variablen-Namen (lt_*, ls_*, lv_*, gs_*, etc.) als Tabellennamen
- ABAP Built-in Typen (C, N, I, F, P, X, D, T, STRING, XSTRING)
- ABAP-interne Typen (ABAP_*, etc.)

**Rückgabe:**

Bei gültigen Feldern:
```
✅ Keine DDIC-Tabellen-Feldreferenzen gefunden. Kein Validierungsbedarf.
```

oder

```
🔍 DDIC-Feldvalidierung für 2 Tabellen/Strukturen:
  ✅ T001: 1 referenzierte Felder geprüft
  ✅ BKPF: 2 referenzierte Felder geprüft

✅ Alle 3 Feldreferenzen sind valide.
```

Bei ungültigen Feldern:
```
❌ 1 ungültige Feldreferenzen gefunden:
  ❌ T001-ABKRS: Feld nicht gefunden (Tabelle hat 20 Felder)

⚠️ Diese Felder existieren nicht in der DDIC — korrigiere die Feldnamen bevor du write_abap_source aufrufst!
💡 Tipp: Nutze get_ddic_element mit dem Tabellennamen um alle verfügbaren Felder zu sehen.
```

**Empfohlener Workflow:**

```
1. Schreibe deinen geplanten ABAP-Code (lokal)
2. Rufe validate_ddic_references(source="...") auf
3. Behebe alle gefundenen Feldnamen-Fehler
4. Rufe write_abap_source auf (sollte jetzt ohne Fehler aktiviert werden)
```

**Beispiel:**

```abap
CODE mit Fehler:
DATA lv_bukrs TYPE T001-BUKRS.     ✅ Valid — BUKRS existiert
DATA lv_foo TYPE T001-ABKRS.       ❌ Invalid — ABKRS existiert NICHT

→ validate_ddic_references() findet den Fehler VOR write_abap_source
```

> **Hinweis:** Dieses Tool ist hilfreich um DDIC-Fehler früh zu erkennen, ersetzt aber nicht den kompletten Syntaxcheck durch `run_syntax_check` oder `write_abap_source`.

---

#### `review_clean_abap`

Prüft ABAP-Quellcode auf Einhaltung der Clean ABAP Richtlinien. Statische Analyse — **keine SAP-Systemverbindung erforderlich**. Erkennt Anti-Patterns und liefert zu jedem Finding den relevanten Abschnitt aus dem offiziellen Clean ABAP Styleguide.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `source` | string | ✓ | ABAP-Quellcode zur Prüfung |
| `maxFindings` | number | | Max. Anzahl Findings (1–50, Default: 10) |

**Erkannte Anti-Patterns (11 Regeln):**

| Regel | Kategorie | Beschreibung |
|-------|-----------|--------------|
| `HUNGARIAN_NOTATION` | Names | Typ-Präfixe wie `lv_`, `lt_`, `gs_` |
| `MOVE_STATEMENT` | Language | Veraltetes `MOVE ... TO` |
| `COMPUTE_STATEMENT` | Language | Veraltetes `COMPUTE` |
| `ADD_SUBTRACT` | Language | Veraltetes `ADD/SUBTRACT ... TO` |
| `MULTIPLY_DIVIDE` | Language | Veraltetes `MULTIPLY/DIVIDE ... BY` |
| `CALL_METHOD` | Language | Veraltetes `CALL METHOD` |
| `FORM_DEFINITION` | Language | `FORM`-Subroutinen statt Methoden |
| `CONCATENATE_STATEMENT` | Strings | `CONCATENATE` statt String Templates |
| `SELECT_ENDSELECT` | Tables | `SELECT...ENDSELECT` statt `INTO TABLE` |
| `CHECK_IN_METHOD` | Methods | `CHECK` in Methoden statt `IF ... RETURN` |
| `CALL_FUNCTION_SYSUBRC` | ErrorHandling | `CALL FUNCTION` + `sy-subrc` statt `TRY/CATCH` |

**Beispiel-Ausgabe:**

```
# Clean ABAP Review — 2 finding(s), 3 occurrence(s)

## [Names] HUNGARIAN_NOTATION — line 1 (2x in source)
❌ Hungarian notation prefix (e.g. lv_, lt_, gs_). Clean ABAP avoids type-encoding prefixes.
   `DATA lv_test TYPE string.`

→ Clean ABAP § **Avoid encodings, esp. Hungarian notation and prefixes**
   <Excerpt aus dem Clean ABAP Guide>

---

## [Language] MOVE_STATEMENT — line 2
❌ Obsolete MOVE ... TO. Use = operator instead.
   `MOVE lv_test TO lv_other.`

→ Clean ABAP § **Prefer functional to procedural language constructs**
   <Excerpt aus dem Clean ABAP Guide>

---
11 rules checked | 📖 clean-abap
```

> **Hinweis:** Dieses Tool ergänzt `run_atc_check` — ATC prüft System-Regeln und technische Korrektheit, `review_clean_abap` prüft Clean ABAP Style-Konventionen. Für optimale Ergebnisse beide kombinieren.

---

### DIAGNOSTICS — Diagnose

#### `get_short_dumps`

Liest die Liste der neuesten Short Dumps. Entspricht Transaktion **ST22**.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `maxResults` | number | | Max. Anzahl (1–100, Default: 20) |
| `user` | string | | Auf bestimmten User einschränken |
| `since` | string | | Zeitfilter ISO-8601, z.B. `2025-03-01T00:00:00Z` |

---

#### `get_short_dump_detail`

Liest die vollständigen Details eines Short Dumps.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `dumpId` | string | ✓ | Dump-ID aus `get_short_dumps` |

**Rückgabe:** Fehlertext, Ausnahme-Kategorie, Call Stack, lokale Variablen zum Zeitpunkt des Fehlers, Quellcode-Position.

---

#### `get_traces`

Liest die Liste der Performance Traces. Entspricht Transaktion **SAT**.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `maxResults` | number | | Max. Anzahl (1–50, Default: 10) |
| `user` | string | | Auf bestimmten User einschränken |

---

#### `get_trace_detail`

Liest die Details eines Performance Traces.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `traceId` | string | ✓ | Trace-ID aus `get_traces` |

**Rückgabe:** Gesamtlaufzeit, Anzahl DB-Zugriffe, teuerste ABAP-Statements und SQL-Selects.

---

### TRANSPORT — Transporte

#### `get_transport_info`

Gibt verfügbare Transportaufträge für ein Objekt zurück.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `objectUrl` | string | ✓ | ADT-URL des Objekts |
| `devClass` | string | ✓ | Paket des Objekts |

---

#### `get_transport_objects`

Listet alle Objekte in einem Transportauftrag auf.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `transportId` | string | ✓ | Transportnummer, z.B. `DEVK900123` |

**Rückgabe:** Liste aller transportierten Objekte mit Typ, Name und Status.

---

#### `create_transport`

Erstellt einen neuen Transportauftrag. Gibt die Transportnummer zurück. ⚠️ Erfordert `ALLOW_WRITE=true`.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `objectUrl` | string | ✓ | ADT-URL des Objekts |
| `description` | string | ✓ | Transportbeschreibung (max. 60 Zeichen) |
| `devClass` | string | ✓ | Paket |
| `transportLayer` | string | | Transport-Layer (optional) |

**Beispiel:**
```
Neuen Transport erstellen
→ create_transport(objectUrl="/sap/bc/adt/oo/classes/zcl_foo", description="Neue Billing-Logik", devClass="ZLOCAL")
```

---

### ABAPGIT — Git-Integration

#### `get_abapgit_repos`

Listet alle abapGit-Repositories auf die im System konfiguriert sind.

**Rückgabe:** Liste mit Repo-ID, Name, Remote-URL, Branch, Package und Status.

---

#### `abapgit_pull`

Führt einen abapGit Pull für ein Repository durch (importiert Code aus Git ins System).

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `repoId` | string | ✓ | Repository-ID aus `get_abapgit_repos` |
| `transport` | string | | Transportauftrag für importierte Objekte |

> ⚠️ Erfordert `ALLOW_WRITE=true`. Kann viele Objekte im System verändern!

---

### QUERY — SQL-Abfragen

#### `run_select_query`

Führt ein SELECT-Statement direkt gegen SAP-Tabellen aus.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `query` | string | ✓ | SELECT-Statement |

**Beispiele:**
```sql
SELECT * FROM T001 WHERE MANDT = '100' UP TO 10 ROWS
SELECT BELNR, BUKRS, BLDAT FROM BKPF WHERE GJAHR = '2025' UP TO 50 ROWS
SELECT COUNT(*) FROM EKKO
```

> ⚠️ Nur lesende Zugriffe erlaubt. DML-Statements (INSERT, UPDATE, DELETE) werden vom System abgelehnt.

---

#### `execute_abap_snippet`

Führt einen temporären ABAP-Code-Schnipsel live im SAP-System aus und gibt die Ausgabe zurück. Das Programm wird in `$TMP` angelegt, sofort ausgeführt und danach automatisch gelöscht — kein permanenter Zustand im System.

Ideal für: Tabellenwerte prüfen, Berechnungen testen, API-Rückgaben inspizieren, Debugging-Hypothesen validieren.

> ⚠️ Erfordert `ALLOW_WRITE=true` **und** `ALLOW_EXECUTE=true`.
> ⚠️ Nur lesende Logik verwenden — schreibende Anweisungen werden statisch geprüft und blockiert.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `source` | string | ✓ | Vollständiger ABAP-Code. Muss mit `REPORT` oder `PROGRAM` beginnen. Ausgabe über `WRITE`. |
| `timeout` | number | | Maximale Laufzeit in Sekunden (1–30, Default: 10) |

**Workflow:**
```
1. Statische Sicherheitsprüfung (verbotene Anweisungen)
2. Temporäres Programm in $TMP anlegen (ZZ_MCP_<timestamp>)
3. Quellcode schreiben (lock → write → unlock)
4. Syntaxcheck — bei Fehlern: abbrechen
5. Aktivieren
6. Ausführen → Ausgabe zurückgeben
7. Programm löschen (immer — auch bei Fehler)
```

**Verbotene Anweisungen (statisch geprüft):**
- `COMMIT WORK`, `ROLLBACK WORK`
- `INSERT`, `UPDATE`, `DELETE`, `MODIFY` auf DB-Tabellen
- `CALL FUNCTION ... IN UPDATE TASK`
- `BAPI_TRANSACTION_COMMIT`

**Beispiele:**
```abap
Tabellenwerte prüfen
→ execute_abap_snippet(source="REPORT ztest.\nSELECT * FROM t001 INTO TABLE @DATA(lt_t001) UP TO 5 ROWS.\nLOOP AT lt_t001 INTO DATA(ls).\n  WRITE: / ls-bukrs, ls-butxt.\nENDLOOP.")

Systemvariablen ausgeben
→ execute_abap_snippet(source="REPORT ztest.\nWRITE: / sy-sysid, sy-mandt, sy-uname, sy-datum.")
```

> **Bekannte Limitation:** Ausgabe-Format hängt von der ADT-Version ab (NW 7.52+). Der `/runs`-Endpunkt ist auf älteren Systemen nicht verfügbar.

---

#### `get_inactive_objects`

Listet alle inaktiven (noch nicht aktivierten) Objekte des aktuellen Benutzers auf.

**Parameter:** Keine.

**Beispiel:**
```
Inaktive Objekte anzeigen
→ get_inactive_objects()
```

---

### DOCUMENTATION — SAP-Dokumentation

#### `get_abap_keyword_doc`

Ruft ABAP-Keyword-Dokumentation von help.sap.com ab. Liefert die offizielle SAP-Doku als formatierten Text.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `keyword` | string | ✓ | ABAP-Keyword (z.B. `SELECT`, `LOOP`, `READ TABLE`, `MODIFY`) |
| `version` | string | | ABAP-Version (z.B. `latest`, `758`, `754`). Default: `SAP_ABAP_VERSION` |

**Beispiele:**
```
SELECT-Dokumentation abrufen
→ get_abap_keyword_doc(keyword="select")

READ TABLE Dokumentation für NW 7.54
→ get_abap_keyword_doc(keyword="read table", version="754")
```

**Verhalten bei 404:** Versucht automatisch eine alternative URL mit Underscores (z.B. `read_table` statt `readtable`).

---

#### `get_abap_class_doc`

Ruft ABAP-Klassen/Interface-Dokumentation von help.sap.com ab.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `className` | string | ✓ | ABAP-Klassenname oder Interface (z.B. `CL_SALV_TABLE`, `IF_AMDP_MARKER_HDB`) |
| `version` | string | | ABAP-Version (z.B. `latest`, `758`, `754`). Default: `SAP_ABAP_VERSION` |

**Beispiel:**
```
CL_SALV_TABLE Dokumentation abrufen
→ get_abap_class_doc(className="CL_SALV_TABLE")
```

---

#### `get_module_best_practices`

Liefert modulspezifische SAP ABAP Best Practices. Jeder Eintrag enthält:
- Wichtige Tabellen & Strukturen
- Empfohlene BAPIs/Klassen (statt Direktzugriff)
- ABAP-Coding-Richtlinien (modulspezifisch)
- Häufige Fehler & Fallstricke
- S/4HANA-Migrationshinweise

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `module` | enum | ✓ | SAP-Modul: `FI`, `CO`, `MM`, `SD`, `PP`, `PM`, `QM`, `HR`, `HCM`, `PS`, `WM`, `EWM`, `BASIS`, `BC`, `ABAP` |

**Beispiel:**
```
FI Best Practices abrufen
→ get_module_best_practices(module="FI")

Allgemeine ABAP Best Practices
→ get_module_best_practices(module="ABAP")
```

> **Aliase:** `HCM` liefert HR-Inhalte, `BC` liefert BASIS-Inhalte.

---

#### `search_clean_abap`

Durchsucht den offiziellen SAP Clean ABAP Styleguide (github.com/SAP/styleguides) nach Best Practices, Namenskonventionen, Coding-Richtlinien und Anti-Patterns. Gibt die relevantesten Abschnitte zurück. **Vor dem Schreiben neuen Codes aufrufen** um Clean ABAP Konventionen einzuhalten.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `query` | string | ✓ | Suchbegriff im Clean ABAP Guide (z.B. `naming conventions`, `error handling`, `method length`) |
| `maxResults` | number | | Max. Anzahl Abschnitte (1–5, Default: 2) |

**Beispiele:**
```
Namenskonventionen nachschlagen
→ search_clean_abap(query="naming conventions")

Error Handling Best Practices
→ search_clean_abap(query="error handling", maxResults=3)
```

---

#### `search_abap_syntax`

Durchsucht die offizielle ABAP-Syntaxdokumentation von help.sap.com anhand einer Freitext-Suche. Identifiziert automatisch das Haupt-Keyword, lädt die Dokumentationsseite und gibt den relevanten Syntax-Abschnitt zurück. **Vor dem Schreiben von ABAP-Code aufrufen** um korrekte Syntax sicherzustellen.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `query` | string | ✓ | Freitext-Suche für ABAP-Syntax (z.B. `SELECT UP TO ROWS`, `LOOP AT clause order`, `READ TABLE WITH KEY`) |
| `version` | string | | ABAP-Version (z.B. `latest`, `758`, `754`). Default: `SAP_ABAP_VERSION` |

**Beispiele:**
```
SELECT-Syntax nachschlagen
→ search_abap_syntax(query="SELECT UP TO ROWS")

LOOP AT Klausel-Reihenfolge prüfen
→ search_abap_syntax(query="LOOP AT clause order")
```

> **Hinweis:** Dieses Tool ist ein Kern-Tool und immer verfügbar (auch im Deferred-Modus).

---

### Konfiguration: `SAP_ABAP_VERSION`

| Variable | Default | Beschreibung |
|----------|---------|--------------|
| `SAP_ABAP_VERSION` | `latest` | ABAP-Version für help.sap.com URLs (z.B. `latest`, `758`, `754`) |

Die Version wird für `get_abap_keyword_doc` und `get_abap_class_doc` verwendet, kann aber pro Aufruf über den `version`-Parameter überschrieben werden.

---

## MCP Prompts

### `abap_develop` — Entwicklungsworkflow

Ein MCP Prompt der einen strukturierten 6-Schritte-Workflow für ABAP-Entwicklung erzwingt. Der Prompt stellt sicher, dass die KI vor dem Coding den vollständigen Kontext erfasst, moderne ABAP-Prinzipien anwendet und Qualitätsprüfungen durchführt.

**Argumente:**

| Argument | Pflicht | Beschreibung |
|----------|---------|--------------|
| `object_name` | ✓ | Name des ABAP-Objekts (z.B. `ZRYBAK_TEST`) |
| `task` | ✓ | Aufgabe (z.B. `ALV-Grid mit CL_SALV_TABLE einbauen`) |

**Workflow-Schritte:**

1. **Kontext erfassen** — `search_abap_objects` → `analyze_abap_context(depth="deep")` → vollständigen Report lesen
2. **Referenzen recherchieren** — Veraltete Patterns erkennen, moderne Alternativen suchen (z.B. `REUSE_ALV_GRID_DISPLAY` → `CL_SALV_TABLE`)
3. **Clean ABAP anwenden** — Bestehenden Code mit `review_clean_abap` prüfen, Inline-Deklarationen, String Templates, funktionale Methoden, ABAP SQL, CX_*-Ausnahmen, OOP
4. **Code-Platzierung** — Richtiges Include / richtige Methode anhand des Kontext-Reports bestimmen
5. **Implementierung** — `write_abap_source` mit Retry bei Syntax-/Aktivierungsfehlern
6. **Qualitätsprüfung** — `run_atc_check`, Findings Priorität 1+2 beheben

**Verwendung in MCP-Clients:**

Der Prompt wird über die MCP Prompt-API aufgerufen. In Claude Desktop oder anderen MCP-Clients kann er direkt als Prompt ausgewählt werden. Er generiert eine User-Message mit dem vollständigen Workflow-Template, das die KI Schritt für Schritt abarbeitet.

---

## ADT Write-Workflow

Alle Write-Operationen auf Quellcode folgen diesem Protokoll:

```
┌──────────────────────────────────────────────────────────────┐
│                    ADT Write Workflow                         │
├──────────┬───────────────────────────────────────────────────┤
│ Schritt  │ Beschreibung                                       │
├──────────┼───────────────────────────────────────────────────┤
│ 1. Lock  │ POST objectUrl?_action=LOCK → lockHandle          │
│          │ Sperrt das Objekt exklusiv für diesen User         │
├──────────┼───────────────────────────────────────────────────┤
│ 2. Write │ PUT objectUrl/source/main (mit lockHandle)         │
│          │ Schreibt den Quellcode auf den Server              │
├──────────┼───────────────────────────────────────────────────┤
│ 3. Check │ POST /sap/bc/adt/abapsource/syntaxcheck            │
│          │ Syntaxfehler → STOP (kein Activate)                │
├──────────┼───────────────────────────────────────────────────┤
│ 4. Act.  │ POST /sap/bc/adt/activation                        │
│          │ Aktiviert das Objekt (Inactive → Active)           │
├──────────┼───────────────────────────────────────────────────┤
│ 5. Unlock│ DELETE objectUrl/locks/lockHandle                   │
│          │ Immer ausgeführt — auch bei Fehlern                │
└──────────┴───────────────────────────────────────────────────┘
```

**Fehlerverhalten:**
- Lock fehlgeschlagen → Exception (Objekt durch anderen User gesperrt)
- Schreiben fehlgeschlagen → Exception + Auto-Unlock
- Syntaxfehler → kein Activate + Auto-Unlock + Fehlerliste zurückgeben
- Activation fehlgeschlagen → Exception + Auto-Unlock
- Beim Auto-Unlock-Fehler → Warnung im Log (manuell in SE03 freigeben)

---

## Sicherheitskonzept

### Mehrstufige Schutzebenen

```
┌─────────────────────────────────────────────────────┐
│  ALLOW_WRITE=false (Default)                        │
│  → Alle schreibenden Tools werfen Fehler            │
├─────────────────────────────────────────────────────┤
│  ALLOW_DELETE=false (Default)                       │
│  → delete_abap_object wirft Fehler                  │
├─────────────────────────────────────────────────────┤
│  BLOCKED_PACKAGES=SAP,SHD,...                       │
│  → Keine Schreibzugriffe auf SAP-Namensräume        │
├─────────────────────────────────────────────────────┤
│  Customer Namespace Check                           │
│  → Namen müssen mit Z/Y beginnen                    │
├─────────────────────────────────────────────────────┤
│  SAP-Autorisierungen (S_ADT_RES, S_DEVELOP)         │
│  → Letzte Verteidigungslinie im System              │
└─────────────────────────────────────────────────────┘
```

### Empfohlene Konfiguration pro Systemtyp

| System | ALLOW_WRITE | ALLOW_DELETE | ALLOW_EXECUTE | BLOCKED_PACKAGES |
|--------|-------------|--------------|---------------|------------------|
| DEV | `true` | `false` | `true` | `SAP,SHD` |
| QAS/TEST | `false` | `false` | `false` | `SAP,SHD` |
| PRD | `false` | `false` | `false` | `SAP,SHD` (nie ändern!) |

---

## ADT Objekt-URL Referenz

| Objekttyp | ADT-URL-Muster |
|-----------|----------------|
| Programm | `/sap/bc/adt/programs/programs/{name}` |
| Klasse | `/sap/bc/adt/oo/classes/{name}` |
| Interface | `/sap/bc/adt/oo/interfaces/{name}` |
| Funktionsgruppe | `/sap/bc/adt/function/groups/{name}` |
| Funktionsbaustein | `/sap/bc/adt/function/groups/{group}/fmodules/{name}` |
| CDS View | `/sap/bc/adt/ddic/ddl/sources/{name}` |
| Tabelle | `/sap/bc/adt/ddic/tables/{name}` |
| Datenelement | `/sap/bc/adt/ddic/dataelements/{name}` |
| Domäne | `/sap/bc/adt/ddic/domains/{name}` |
| Nachrichtenklasse | `/sap/bc/adt/messageclass/{name}` |

Quellcode einer Einheit lesen/schreiben: URL + `/source/main`

---

## Fehlerbehebung

| Fehler | Mögliche Ursache | Lösung |
|--------|-----------------|--------|
| `401 Unauthorized` | Falsche Credentials | SAP_USER/SAP_PASSWORD prüfen |
| `ADT_SRV not found` | SICF nicht aktiviert | `/sap/bc/adt` in SICF aktivieren |
| `Lock failed` | Objekt durch anderen User gesperrt | In SE03 oder ADT Lock manuell freigeben |
| `Write disabled` | ALLOW_WRITE=false | In `.env` auf `true` setzen (nur DEV!) |
| `Package blocked` | Package in BLOCKED_PACKAGES | BLOCKED_PACKAGES anpassen oder anderes Paket verwenden |
| `Namespace violation` | Name beginnt nicht mit Z/Y | Customer Namespace einhalten |
| `Connection refused` | System nicht erreichbar | VPN-Verbindung prüfen, SAP-System läuft? |
| `SSL error` | Self-signed Zertifikat | `NODE_TLS_REJECT_UNAUTHORIZED=0` setzen (nur DEV!) |
| `codeCompletion is not a function` | Alte abap-adt-api Version | `npm update abap-adt-api` |
| `dumpsList is not a function` | System zu alt (< NW 7.52) | Feature nicht verfügbar auf diesem System |

---

## Bekannte Einschränkungen

- **Pretty Print**: Erfordert NW 7.51+ und abapfs_extensions Plugin auf dem System.
- **Code Completion**: Liefert systemspezifische Vorschläge — auf älteren Systemen ggf. eingeschränkt.
- **ATC-Checks**: Asynchrone Prüfungen können je nach System-Last mehrere Sekunden dauern.
- **Short Dumps / Traces**: Nur verfügbar auf NW >= 7.52; auf älteren Systemen gibt `get_short_dumps` eine Fehlermeldung zurück.
- **abapGit Pull**: Erfordert dass abapGit im System installiert ist und der User abapGit-Berechtigung hat.
- **Debugger**: Der ABAP-Debugger ist nicht per MCP steuerbar — das ist eine VS Code-spezifische Funktion.
- **Gleichzeitige Locks**: Der Server hält nur eine ADT-Session. Bei parallelen Write-Operationen können Lock-Konflikte entstehen.

---

*Letzte Aktualisierung: [Aktuelle Version]*
*Basiert auf: abap-adt-api v8.x, @modelcontextprotocol/sdk v1.x*
