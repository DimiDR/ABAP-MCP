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
  System  : https://ihr-sap-system:44300
  User    : DEVELOPER  Client: 100
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
      "args": ["C:/pfad/zu/abap-mcp-server-v2/dist/index.js"],
      "env": {
        "SAP_URL": "https://ihr-dev-system:44300",
        "SAP_USER": "DEVELOPER",
        "SAP_PASSWORD": "IhrPasswort",
        "SAP_CLIENT": "100",
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
      "args": ["C:/pfad/zu/abap-mcp-server-v2/dist/index.js"]
    }
  }
}
```




1. Port

  Der Server läuft auf keinem Port. Er nutzt StdioServerTransport (Zeile 30 in src/index.ts), d.h. er
   kommuniziert über stdin/stdout — nicht über HTTP/TCP. Das ist das Standard-Protokoll für
  MCP-Server.

  2. In Claude Code anbinden

  Erstelle/bearbeite die Datei ~/.claude/settings.json (oder die projektlokale .claude/settings.json)
   und füge den Server hinzu:

  {
    "mcpServers": {
      "abap": {
        "command": "node",
        "args": ["C:/Users/rybak/Downloads/Apps/ABAP_MCP/dist/index.js"],
        "env": {
          "SAP_URL": "https://ihr-sap-system:44300",
          "SAP_USER": "DEVELOPER",
          "SAP_PASSWORD": "IhrPasswort",
          "SAP_CLIENT": "100",
          "SAP_LANGUAGE": "DE",
          "ALLOW_WRITE": "false"
        }
      }
    }
  }

  Alternativ, wenn du die .env-Datei nutzen willst (die liegt ja schon vor), kannst du statt node    
  auch npx tsx verwenden:

  {
    "mcpServers": {
      "abap": {
        "command": "npx",
        "args": ["tsx", "C:/Users/rybak/Downloads/Apps/ABAP_MCP/src/index.ts"],
        "cwd": "C:/Users/rybak/Downloads/Apps/ABAP_MCP"
      }
    }
  }

  Mit cwd gesetzt wird die .env-Datei automatisch von dotenv geladen.

  Schritte:
  1. Erst .env mit deinen echten SAP-Zugangsdaten ausfüllen
  2. npm run build ausführen (oder npm run dev für Entwicklung)
  3. Die obige Konfiguration in ~/.claude/settings.json eintragen
  4. Claude Code neu starten — die ABAP-Tools sollten dann verfügbar sein