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
7. [ADT Write-Workflow](#adt-write-workflow)
8. [Sicherheitskonzept](#sicherheitskonzept)
9. [ADT Objekt-URL Referenz](#adt-objekt-url-referenz)
10. [Fehlerbehebung](#fehlerbehebung)
11. [Bekannte Einschränkungen](#bekannte-einschränkungen)

---

## Überblick

Der ABAP MCP Server ermöglicht KI-Assistenten (Claude, GitHub Copilot, Cursor usw.) direkten
Zugriff auf ein SAP ABAP-System über die ADT REST API — ohne VS Code als Brücke.

**38 Tools** in 11 Gruppen + 1 Meta-Tool decken den kompletten ABAP-Entwicklungsworkflow ab:

| Gruppe | Anzahl Tools | Beschreibung |
|--------|-------------|--------------|
| SEARCH | 1 | Objektsuche mit Wildcards |
| READ | 5 | Quellcode, Metadaten, Where-Used, Code Completion |
| WRITE | 4 | Quellcode schreiben, aktivieren, formatieren |
| CREATE | 7 | Programme, Klassen, Interfaces, FuGr, CDS, Tabellen, Messages |
| DELETE | 1 | Objekte löschen |
| TEST | 2 | Unit Tests ausführen, Test-Includes erstellen |
| QUALITY | 2 | Syntaxcheck, ATC-Prüfungen |
| DIAGNOSTICS | 4 | Short Dumps, Performance Traces |
| TRANSPORT | 2 | Transport-Infos, Transport-Inhalte |
| ABAPGIT | 2 | Repos auflisten, Pull ausführen |
| QUERY | 1 | SELECT-Statements direkt ausführen |
| META | 1 | Tool-Finder für dynamische Tool-Registrierung |

> **Token-Optimierung:** Mit `DEFER_TOOLS=true` (Default) werden initial nur 7 Kern-Tools geladen.
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
git clone https://github.com/your-org/abap-mcp-server
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
| `BLOCKED_PACKAGES` | | `SAP,SHD` | Kommaliste gesperrter Paket-Präfixe |
| `DEFAULT_TRANSPORT` | | — | Standard-Transport wenn nicht angegeben |
| `SYNTAX_CHECK_BEFORE_ACTIVATE` | | `true` | Syntaxcheck vor Aktivierung erzwingen |
| `MAX_DUMPS` | | `20` | Maximale Anzahl Short Dumps |
| `DEFER_TOOLS` | | `true` | Tool-Deferred-Modus: initial nur Kern-Tools laden |

### Beispiel .env (Entwicklungssystem)

```env
SAP_URL=https://s4dev.example.com:44300
SAP_USER=DEVELOPER
SAP_PASSWORD=DevPass123!
SAP_CLIENT=100
SAP_LANGUAGE=DE
ALLOW_WRITE=true
ALLOW_DELETE=false
BLOCKED_PACKAGES=SAP,SHD,SMOD
DEFAULT_TRANSPORT=DEVK900042
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
        "SAP_URL": "https://dev-system:44300",
        "SAP_USER": "DEVELOPER",
        "SAP_PASSWORD": "Password",
        "SAP_CLIENT": "100",
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
      "args": ["/pfad/zum/abap-mcp-server/dist/index.js"]
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
| `category` | string | | Kategorie: `SEARCH`, `READ`, `WRITE`, `CREATE`, `DELETE`, `TEST`, `QUALITY`, `DIAGNOSTICS`, `TRANSPORT`, `ABAPGIT`, `QUERY` |
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

**Kern-Tools (immer verfügbar):** `search_abap_objects`, `read_abap_source`, `write_abap_source`, `get_object_info`, `where_used`, `find_tools`

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

### READ — Lesen

#### `read_abap_source`

Liest den vollständigen Quellcode eines ABAP-Objekts.

**Parameter:**

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `objectUrl` | string | ✓ | ADT-URL des Objekts |

**Beispiel:**
```
Lies den Quellcode von ZCL_BILLING_SERVICE
→ read_abap_source(objectUrl="/sap/bc/adt/oo/classes/zcl_billing_service")
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
| `mainProgram` | string | | Hauptprogramm (für Includes) |

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
| `source` | string | ✓ | Vollständiger ABAP-Quellcode |
| `transport` | string | | Transportauftrag |
| `activateAfterWrite` | boolean | | Aktivieren nach dem Schreiben (Default: true) |
| `skipSyntaxCheck` | boolean | | Syntaxcheck überspringen (Default: false) |

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
| `objectUrl` | string | | ADT-URL für Kontext |
| `indentation` | boolean | | Einrückung normalisieren (Default: true) |
| `style` | enum | | `keywordUpper` \| `keywordLower` \| `keywordMixed` (Default: keywordUpper) |

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

| System | ALLOW_WRITE | ALLOW_DELETE | BLOCKED_PACKAGES |
|--------|-------------|--------------|------------------|
| DEV | `true` | `false` | `SAP,SHD` |
| QAS/TEST | `false` | `false` | `SAP,SHD` |
| PRD | `false` | `false` | `SAP,SHD` (nie ändern!) |

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

*Letzte Aktualisierung: März 2026*  
*Basiert auf: abap-adt-api v8.x, @modelcontextprotocol/sdk v1.x*
