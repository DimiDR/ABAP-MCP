# ABAP MCP Server — Updates & Changelog

---

## 2026-03-25 — get_table_fields Tool

### Neues Tool: `get_table_fields`

**Problem:** `get_ddic_element` nutzt den ADT-Endpoint `/sap/bc/adt/ddic/ddl/elementinfo`, der primär für CDS/DDL-Elemente konzipiert ist. Bei klassischen DDIC-Tabellen (VBAK, MARA etc.) liefert er leere Ergebnisse (`children: [], elementProps: false`).

**Lösung:** Neues Tool `get_table_fields`, das den Data-Preview-Endpoint (`tableContents` mit `rowNumber=1`) nutzt. Dieser liefert zuverlässig den kompletten Feldkatalog für transparente Tabellen, Views und CDS-Entities — inkl. Feldname, ABAP-Typ, Beschreibung, Key-Flag und Länge.

**Technische Details:**
- Ruft `client.tableContents(tableName, 1, false)` auf und gibt nur das `columns`-Array zurück
- Mappt `QueryResultColumn` auf ein kompaktes Feld-Objekt (name, type, description, isKey, length, isKeyFigure)
- Zusammenfassung in der Antwort: Anzahl Felder + Anzahl Key-Felder
- Kategorie: READ
- Nicht in Core Tools (Deferred Loading)

**Dateien:**
- `src/schemas.ts` — `S_GetTableFields` Schema
- `src/tools/tool-definitions.ts` — Tool-Definition
- `src/tools/handlers/read.ts` — `handleGetTableFields` Handler
- `src/tools/handler-map.ts` — Dispatch-Eintrag
- `src/tools/tool-registry.ts` — READ-Kategorie + Short Description
- `DOCUMENTATION.md` — Tool-Referenz
- `readme.md` — Tool-Zähler aktualisiert (49 → 50)

---

## 2026-03-25 — search_source_code als Core Tool

### Änderung: `search_source_code` zu Core Tools hinzugefügt

**Hintergrund:** Quellcode-Volltextsuche ist eine Grundfunktion bei der ABAP-Entwicklung. Zusammen mit `search_abap_objects` bildet es das Such-Paar — Objekte nach Name vs. Inhalte nach Text. Es wird in den meisten Workflows gebraucht (Bug-Suche, Refactoring, Impact-Analyse) und sollte ohne vorheriges `find_tools` verfügbar sein.

**Änderung:** `search_source_code` ist jetzt eines von 12 Core Tools (vorher 11) und wird bei `DEFER_TOOLS=true` immer sofort geladen.

**Core Tools (12):** `find_tools`, `list_tools`, `search_abap_objects`, `search_source_code`, `read_abap_source`, `write_abap_source`, `get_object_info`, `where_used`, `analyze_abap_context`, `search_abap_syntax`, `validate_ddic_references`, `batch_read`

**Dateien:**
- `src/tools/tool-registry.ts` — `CORE_TOOL_NAMES` erweitert
- `CLAUDE.md` — Core-Tool-Liste aktualisiert
- `readme.md` — Banner-Anzeige aktualisiert
- `DOCUMENTATION.md` — Kern-Tool-Anzahl aktualisiert

---

## 2026-03-25 — search_sap_web Tool (Tavily Web Search)

### Neues Tool: `search_sap_web`

**Problem:** Die bestehenden Doku-Tools (`get_abap_keyword_doc`, `search_abap_syntax`) arbeiten mit direkter URL-Konstruktion und finden nur Treffer, wenn der Keyword-Slug exakt passt. Fuer Fehlermeldungen, SAP Notes, Community-Blogartikel, KBAs und allgemeine SAP-Problemloesungen fehlte eine Suchmoeglichkeit.

**Loesung:** Das neue `search_sap_web`-Tool durchsucht SAP Help, SAP Community und SAP Notes via Tavily Search API. Es gibt kompakte Ergebnisse zurueck (Titel + URL + Snippet), um den Token-Verbrauch minimal zu halten.

**Technische Details:**
- Nutzt Tavily Search API (1000 Searches/Monat kostenlos)
- Durchsucht parallel bis zu 3 Quellen: `help.sap.com`, `community.sap.com`, `me.sap.com`
- Query wird automatisch mit "SAP ABAP" angereichert fuer bessere Relevanz
- Parallele Ausfuehrung via `Promise.allSettled()` — alle Quellen gleichzeitig
- Ergebnis pro Treffer: Titel + URL + Snippet (~3 Zeilen) — gesamtes Tool-Ergebnis unter 500 Tokens
- Fehlertoleranz: Einzelne fehlgeschlagene Quellen stoppen nicht die anderen

**Setup:**
1. https://tavily.com/ → Sign up → API Key kopieren
2. `TAVILY_API_KEY` in `.env` eintragen

**Beispiel:**
```json
{
  "tool": "search_sap_web",
  "args": {
    "query": "CX_SY_OPEN_SQL_DB error SELECT",
    "sources": ["help", "community"],
    "maxResults": 5
  }
}
```

**Kosten:** Free Tier: 1000 Searches/Monat.

**Neue Kategorie:** WEBSEARCH (in `TOOL_CATEGORIES`)

**Dateien:**
- `src/config.ts` — `tavilyApiKey` Config-Feld
- `src/schemas.ts` — `S_SearchSapWeb` Schema
- `src/tools/handlers/websearch.ts` — Handler (neu)
- `src/tools/tool-definitions.ts` — Tool-Definition
- `src/tools/handler-map.ts` — Dispatch-Registrierung
- `src/tools/tool-registry.ts` — Kategorie + Short Description
- `.env` / `.env.example` — `TAVILY_API_KEY`
- `src/index.ts` — Banner zeigt WebSearch-Status

---

## 2026-03-25 — batch_read Tool (Performance-Optimierung)

### Neues Tool: `batch_read`

**Problem:** MCP-Clients wie Cline (VS Code Extension) fuehren Tool-Aufrufe sequenziell aus — ein Call nach dem anderen. Bei ABAP-Entwicklungsworkflows, die viele Leseoperationen erfordern (Source lesen, Where-Used, Object Info, Kontext-Analyse), fuehrt das zu langen Wartezeiten.

**Loesung:** Das neue `batch_read`-Tool buendelt mehrere Read-Only-Operationen in einem einzigen MCP-Call. Der Server fuehrt sie intern parallel via `Promise.allSettled()` aus und gibt alle Ergebnisse zusammen zurueck.

**Technische Details:**
- Bis zu 20 Operationen pro Batch-Call
- Jede Operation referenziert ein bestehendes Tool (Name + Args)
- Nur Read-Only-Tools erlaubt — Write/Create/Delete sind blockiert
- Ergebnisse werden pro Operation mit Label und Status (OK/FEHLER) zurueckgegeben
- Fehlertoleranz: Einzelne fehlgeschlagene Operationen stoppen nicht den Batch
- Als Core-Tool registriert (immer verfuegbar, kein `find_tools` noetig)

**Beispiel:**
```json
{
  "tool": "batch_read",
  "args": {
    "operations": [
      { "tool": "read_abap_source", "args": { "objectUrl": "/sap/bc/adt/programs/programs/ztest", "includeRelated": true }, "label": "source" },
      { "tool": "where_used", "args": { "objectUrl": "/sap/bc/adt/programs/programs/ztest" }, "label": "usages" },
      { "tool": "get_object_info", "args": { "objectUrl": "/sap/bc/adt/programs/programs/ztest" }, "label": "info" }
    ]
  }
}
```

**Performance-Gewinn:**
- Cline sieht 1 Tool-Call statt N
- Server feuert N HTTP-Requests parallel an SAP
- Gesamtzeit ~ langsamster Einzelrequest statt Summe aller Requests

**Hintergrund:** ADT (ABAP Development Tools) REST API hat keine native Batch-API. Die Parallelisierung passiert im Node.js MCP Server, der die einzelnen HTTP-Requests via `Promise.allSettled()` gleichzeitig abfeuert.

**Neue Kategorie:** BATCH (in `TOOL_CATEGORIES`)

**Dateien:**
- `src/schemas.ts` — `S_BatchRead` Schema
- `src/tools/handlers/batch.ts` — Handler (neu)
- `src/tools/tool-definitions.ts` — Tool-Definition
- `src/tools/handler-map.ts` — Dispatch-Registrierung
- `src/tools/tool-registry.ts` — Kategorie + Core-Tool + Short Description
