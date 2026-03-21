# ABAP MCP Server v2

Standalone MCP Server für agentives ABAP-Development — 47+ Tools via ADT REST API.

---

## Quickstart

**1. Abhängigkeiten installieren & bauen**
```bash
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
  User    : <USERNAME>  Client: <CLIENT>  Lang: EN
  Write   : ❌ deaktiviert
  Delete  : ❌ deaktiviert
  Tools   : 10 initial (49 gesamt, deferred)
  Doku    : help.sap.com vlatest
  Prompts : 1 (abap_develop)
  ADT     : ✅ Verbunden
✅ MCP Server läuft auf stdio — bereit für Verbindungen
```

---

## MCP-Client Konfiguration

**Wichtig:** Den Server rufst du normalerweise **nicht manuell** auf — er wird vom MCP-Client (Claude Desktop, Claude Code usw.) automatisch gestartet. Du trägst ihn einmalig in die Config ein:

### Claude Desktop

`%APPDATA%\Claude\claude_desktop_config.json` (Windows):
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

### Claude Code

Im Projektordner `.claude/mcp.json`:
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

### Cline (VS Code Extension)

In VS Code öffne die Cline Settings (Cline-Symbol → Settings) und gehe zu "MCP Server Configuration". Dort ergänze:

```json
{
  "mcpServers": {
    "abap": {
      "autoApprove": [
        "search_abap_objects",
        "read_abap_source",
        "get_object_info",
        "where_used",
        "write_abap_source",
        "analyze_abap_context",
        "find_tools",
        "abap_develop"
      ],
      "disabled": false,
      "timeout": 60,
      "type": "stdio",
      "command": "node",
      "args": [
        "/pfad/zum/abap-mcp-server/dist/index.js"
      ],
      "env": {
        "SAP_URL": "https://<SAP_SYSTEM>:<PORT>",
        "SAP_USER": "<USERNAME>",
        "SAP_PASSWORD": "<PASSWORD>",
        "SAP_CLIENT": "<CLIENT>",
        "SAP_LANGUAGE": "EN",
        "ALLOW_WRITE": "true",
        "DEFAULT_TRANSPORT": "",
        "ALLOW_EXECUTE": "true",
        "BLOCKED_PACKAGES": "SAP,SHD,SMOD",
        "SYNTAX_CHECK_BEFORE_ACTIVATE": "true",
        "MAX_DUMPS": "20",
        "DEFER_TOOLS": "true",
        "SAP_ABAP_VERSION": "latest",
        "NODE_TLS_REJECT_UNAUTHORIZED": "0"
      }
    }
  }
}
```

**Hinweise:**
- `autoApprove` listet die Tools auf, die ohne Benutzerbestätigung ausgeführt werden dürfen. Erweitere die Liste nach Bedarf (z.B. `search_abap_syntax`, `validate_ddic_references`).
- `timeout`: Maximale Laufzeit pro Tool-Aufruf in Sekunden (60 empfohlen für ATC-Checks u.ä.).
- `NODE_TLS_REJECT_UNAUTHORIZED=0`: Nur bei Self-signed Zertifikaten (DEV-Systeme) setzen!
- Alle `env`-Variablen können alternativ in einer `.env`-Datei im Server-Verzeichnis konfiguriert werden.

Nach dem Speichern: Cline neu starten oder die MCP-Verbindung neu laden.

---

## Credentials konfigurieren

Der Server lädt die Credentials aus der `.env`-Datei im Projekt:

```bash
# Pflicht
SAP_URL=https://<SAP_SYSTEM>:<PORT>
SAP_USER=<USERNAME>
SAP_PASSWORD=<PASSWORD>
SAP_CLIENT=<CLIENT>
SAP_LANGUAGE=EN

# Sicherheit (alle default-safe)
ALLOW_WRITE=false
ALLOW_DELETE=false
ALLOW_EXECUTE=false
BLOCKED_PACKAGES=SAP,SHD,SMOD

# Optionen
SYNTAX_CHECK_BEFORE_ACTIVATE=true
DEFER_TOOLS=true
SAP_ABAP_VERSION=latest
DEFAULT_TRANSPORT=
MAX_DUMPS=20
```

Du brauchst die Credentials **nicht** in der MCP-Config zu wiederholen — der Server lädt sie automatisch beim Start.

**Empfohlene Einstellungen pro Umgebung:**

| Variable | DEV | QAS/TEST | PROD |
|---|---|---|---|
| `ALLOW_WRITE` | `true` | `false` | `false` |
| `ALLOW_DELETE` | `false` | `false` | `false` |
| `ALLOW_EXECUTE` | `true` | `false` | `false` |

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

## Troubleshooting

**"ADT Fehler: User ist currently editing..."**
- Der Server versucht, eine Datei zu sperren, die schon gesperrt ist (z.B. von einem vorherigen Fehler)
- Lösung: SAP Studio öffnen und die Lock-Session beenden, oder Server neu starten

**Include-Aktivierungsfehler**
- Includes können nicht standalone aktiviert werden
- Der Server erkennt das automatisch und aktiviert die Include im Kontext des Hauptprogramms
- Falls nötig, `mainProgram`-Parameter beim Schreiben angeben

**"SAP_URL, SAP_USER and SAP_PASSWORD must be set"**
- `.env`-Datei fehlt oder Server wurde aus dem falschen Verzeichnis gestartet
- Bei Cline: `cwd`-Feld in der MCP-Config prüfen

**Connection refused**
- VPN aktiv? SAP-System erreichbar? URL korrekt?

**Self-signed Zertifikat (nur DEV)**
- In der `.env` oder MCP-Config `env` setzen: `NODE_TLS_REJECT_UNAUTHORIZED=0`
- Nur für Entwicklungssysteme mit Self-signed Zertifikaten!
