#!/usr/bin/env node
/**
 * ABAP MCP Server — Entry Point
 * Prints banner, connects MCP transport, starts serving.
 */

import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { cfg } from "./config.js";
import { getClient } from "./adt-client.js";
import { server } from "./server.js";
import { CORE_TOOL_NAMES, ALL_TOOLS } from "./tools/tool-registry.js";

// ── Startup ─────────────────────────────────────────────────────────────────

async function main() {
  const wIcon = cfg.allowWrite  ? "✅ aktiv" : "❌ deaktiviert";
  const dIcon = cfg.allowDelete ? "✅ aktiv" : "❌ deaktiviert";
  console.error("╔══════════════════════════════════════════╗");
  console.error("║   ABAP MCP Server v2.0 — Extended        ║");
  console.error("╚══════════════════════════════════════════╝");
  console.error(`  System  : ${cfg.url}`);
  console.error(`  User    : ${cfg.user}  Client: ${cfg.client}  Lang: ${cfg.language}`);
  console.error(`  Write   : ${wIcon}`);
  console.error(`  Delete  : ${dIcon}`);
  const eIcon = cfg.allowExecute ? "✅ aktiv" : "❌ deaktiviert";
  if (cfg.allowWrite) {
    console.error(`  Blocked : ${cfg.blockedPackages.join(", ") || "keine"}`);
    console.error(`  Execute : ${eIcon}`);
  }
  const tIcon = cfg.deferTools
    ? `${CORE_TOOL_NAMES.size} initial (${ALL_TOOLS.length} gesamt, deferred)`
    : `${ALL_TOOLS.length} registriert`;
  console.error(`  Tools   : ${tIcon}`);
  console.error(`  Doku    : help.sap.com v${cfg.sapAbapVersion}`);
  const gIcon = cfg.tavilyApiKey ? "✅ aktiv" : "❌ nicht konfiguriert";
  console.error(`  WebSrch : ${gIcon}`);
  console.error(`  Prompts : 1 (abap_develop)`);

  try {
    await getClient();
    console.error("  ADT     : ✅ Verbunden");
  } catch (e) {
    console.error(`  ADT     : ⚠️  Verbindung fehlgeschlagen — ${(e as Error).message}`);
    console.error("            Server läuft weiter; Verbindung wird beim ersten Tool-Aufruf erneut versucht.");
  }
  console.error("");

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("✅ MCP Server läuft auf stdio — bereit für Verbindungen");
}

main().catch(e => { console.error("Fataler Fehler:", e); process.exit(1); });
