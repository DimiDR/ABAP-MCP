Drei Schritte:

**1. Abhängigkeiten installieren & bauen**
```bash
cd abap-mcp-server-v2
npm install
npm run build
```

**2. Konfiguration**
```bash
cp .env.example .env
# .env öffnen und SAP_URL, SAP_USER, SAP_PASSWORD eintragen
```

**3. Starten**
```bash
npm start
# oder direkt:
node dist/index.js
```

Wenn alles klappt, siehst du:
```
╔══════════════════════════════════════════╗
║   ABAP MCP Server v2.0 — Extended        ║
╚══════════════════════════════════════════╝
  System  : https://<SAP_SYSTEM>:<PORT>
  User    : <USERNAME>  Client: <CLIENT>
  Write   : ❌ deaktiviert
  Tools   : 30 registriert
  ADT     : ✅ Verbunden
✅ MCP Server läuft auf stdio — bereit für Verbindungen
```

---

**Wichtig:** Den Server rufst du normalerweise **nicht manuell** auf — er wird vom MCP-Client (Claude Desktop, Claude Code usw.) automatisch gestartet. Du trägst ihn einmalig in die Config ein:

**Claude Desktop** (`%APPDATA%\Claude\claude_desktop_config.json` auf Windows):
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

Dann Claude Desktop neu starten — der Server läuft im Hintergrund sobald du eine Konversation öffnest.

**Claude Code** (im Projektordner `.claude/mcp.json`):
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

**Cline** (VS Code Extension):

In VS Code öffne die Cline Settings (Cline-Symbol → Settings) und gehe zu "MCP Server Configuration". Dort ergänze:

```json
{
  "mcpServers": {
    "abap": {
      "command": "node",
      "args": ["/pfad/zum/abap-mcp-server/dist/index.js"],
      "cwd": "/pfad/zum/abap-mcp-server",
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

**Wichtig:** Das `cwd`-Feld ist notwendig, damit der Server die `.env`-Datei aus dem richtigen Verzeichnis lädt. Ohne `cwd` schlägt der Start mit "SAP_URL, SAP_USER and SAP_PASSWORD must be set" fehl.

Nach dem Speichern: Cline neu starten oder die MCP-Verbindung neu laden.

---

## Warum braucht der Server keinen Port?

Der ABAP MCP Server läuft im **stdio-Modus** (Standard Input/Output), nicht im HTTP-Modus:

- **stdio-Modus** (dieser Server) ✅
  - Der Server kommuniziert über stdin/stdout direkt mit dem Client
  - Kein HTTP-Server, kein TCP-Port nötig
  - Das ist der Standard für MCP (Model Context Protocol)
  - Wird vom Client automatisch gestartet, wenn benötigt
  - Perfekt für: Claude Desktop, Claude Code, Cline

- **HTTP-Modus** (optional, z.B. für externe Clients)
  - Server lauscht auf TCP-Port (z.B. 4847)
  - Clients verbinden sich via HTTP
  - Nötig wenn du mehrere Client-Prozesse hast oder externe Integration brauchst

**Kurz:** Du brauchst keinen Port, weil dein Client (Claude, Cline) den Server direkt startet und über stdio mit ihm spricht. Das ist schneller und sicherer.

---

## Credentials konfigurieren

Der Server lädt die Credentials aus der `.env`-Datei im Projekt:

```bash
SAP_URL=https://<SAP_SYSTEM>:<PORT>
SAP_USER=<USERNAME>
SAP_PASSWORD=<PASSWORD>
SAP_CLIENT=<CLIENT>
SAP_LANGUAGE=<LANGUAGE>
ALLOW_WRITE=<true|false>
```

Du brauchst die Credentials **nicht** in der MCP-Config zu wiederholen — der Server lädt sie automatisch beim Start.

## Troubleshooting

**"ADT Fehler: User ist currently editing..."**
- Der Server versucht, eine Datei zu sperren, die schon gesperrt ist (z.B. von einem vorherigen Fehler)
- Lösung: SAP Studio öffnen und die Lock-Session beenden, oder Server neu starten

**Include-Aktivierungsfehler**
- Includes können nicht standalone aktiviert werden
- Der Server erkennt das automatisch und aktiviert die Include im Kontext des Hauptprogramms
- Falls nötig, `mainProgram`-Parameter beim Schreiben angeben