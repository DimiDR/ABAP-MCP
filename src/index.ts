#!/usr/bin/env node
/**
 * ABAP MCP Server — Extended Edition
 * ====================================
 * Vollständiger Standalone MCP Server für agentives ABAP-Development.
 * Deckt alle 30+ Tools des vscode_abap_remote_fs MCP ab und ergänzt
 * Write-Funktionalität direkt über die SAP ADT REST API.
 *
 * Tool-Gruppen:
 *   [SEARCH]    Objektsuche & Navigation
 *   [READ]      Quellcode & Metadaten lesen
 *   [WRITE]     Quellcode schreiben & aktivieren
 *   [CREATE]    Objekte anlegen (7 Typen)
 *   [DELETE]    Objekte löschen
 *   [TEST]      Unit Tests & Test-Includes
 *   [QUALITY]   ATC, Syntaxcheck, Pretty Print
 *   [DIAG]      Short Dumps & Performance Traces
 *   [TRANSPORT] Transport-Management
 *   [GIT]       abapGit Integration
 *   [QUERY]     SELECT-Queries
 *   [DOC]       SAP-Dokumentation & Best Practices
 *
 * ADT Write-Workflow:
 *   lock → setObjectSource → syntaxCheck → activate → unLock
 */

import "dotenv/config";
import { ADTClient, createSSLConfig, session_types, isAdtError } from "abap-adt-api";
import type { ActivationResult, ActivationResultMessage, ClientOptions } from "abap-adt-api";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// ============================================================================
// CONFIGURATION
// ============================================================================

const cfg = {
  url:                     process.env.SAP_URL ?? "",
  user:                    process.env.SAP_USER ?? "",
  password:                process.env.SAP_PASSWORD ?? "",
  client:                  process.env.SAP_CLIENT ?? "100",
  language:                process.env.SAP_LANGUAGE ?? "EN",
  allowWrite:              process.env.ALLOW_WRITE === "true",
  allowDelete:             process.env.ALLOW_DELETE === "true",
  blockedPackages:         (process.env.BLOCKED_PACKAGES ?? "SAP,SHD")
                             .split(",").map(s => s.trim().toUpperCase()).filter(Boolean),
  defaultTransport:        process.env.DEFAULT_TRANSPORT ?? "",
  syntaxCheckBeforeActivate: process.env.SYNTAX_CHECK_BEFORE_ACTIVATE !== "false",
  maxDumps:                parseInt(process.env.MAX_DUMPS ?? "20", 10),
  allowUnauthorized:       process.env.SAP_ALLOW_UNAUTHORIZED === "true",
  deferTools:              process.env.DEFER_TOOLS !== "false",
  sapAbapVersion:          process.env.SAP_ABAP_VERSION ?? "latest",
};

if (!cfg.url || !cfg.user || !cfg.password) {
  console.error("ERROR: SAP_URL, SAP_USER and SAP_PASSWORD must be set in .env");
  process.exit(1);
}

// ============================================================================
// ADT CLIENT — lazy init, single connection
// ============================================================================

let adtClient: ADTClient | null = null;

async function getClient(): Promise<ADTClient> {
  if (adtClient) {
    try {
      await adtClient.httpClient.request("/sap/bc/adt/core/discovery", { method: "HEAD" });
      return adtClient;
    } catch {
      adtClient = null; // Session abgelaufen → neu aufbauen
    }
  }
  const sslConfig = cfg.allowUnauthorized ? createSSLConfig(true) : {};
  const options: ClientOptions = { keepAlive: true, ...sslConfig };
  adtClient = new ADTClient(cfg.url, cfg.user, cfg.password, cfg.client, cfg.language, options);
  try {
    await adtClient.login();
  } catch (e) {
    adtClient = null;
    throw new McpError(ErrorCode.InternalError,
      `ADT-Verbindung nicht verfügbar: ${e instanceof Error ? e.message : String(e)}. Prüfe: SAP_URL erreichbar? VPN aktiv? SICF /sap/bc/adt aktiviert? Credentials korrekt?`);
  }
  return adtClient;
}

// ============================================================================
// CONCURRENCY GUARD — serialize write operations
// ============================================================================

let writeLock: Promise<void> = Promise.resolve();

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock;
  let release: () => void;
  writeLock = new Promise<void>(resolve => { release = resolve; });
  return prev.then(fn).finally(() => release!());
}

// ============================================================================
// STATEFUL SESSION HELPER — enable/disable stateful mode for write workflows
// ============================================================================

async function withStatefulSession<T>(client: ADTClient, fn: () => Promise<T>): Promise<T> {
  client.stateful = session_types.stateful;
  try {
    return await fn();
  } finally {
    try { await client.dropSession(); } catch (e) {
      console.error("⚠️ dropSession fehlgeschlagen:", e instanceof Error ? e.message : String(e));
    }
    client.stateful = session_types.stateless;
  }
}

// ============================================================================
// LOCK HELPER — retry lock after dropping stale session
// ============================================================================

async function lockWithRetry(client: ADTClient, objectUrl: string): Promise<{ LOCK_HANDLE: string }> {
  try {
    return await client.lock(objectUrl);
  } catch (lockErr: any) {
    const msg = String(lockErr?.message ?? lockErr ?? "");
    if (msg.includes("currently editing") || msg.includes("ist gesperrt") || msg.includes("is currently editing")) {
      // Stale lock from a previous session — drop session to release it
      try { await client.dropSession(); } catch { /* ignore */ }
      client.stateful = session_types.stateful;
      try {
        return await client.lock(objectUrl);
      } catch {
        // dropSession didn't release the lock — full logout + login to discard
        // all stale cookies/session state and start completely fresh
        try { await client.dropSession(); } catch { /* ignore */ }
        try { await client.logout(); } catch { /* ignore */ }
        await client.login();
        client.stateful = session_types.stateful;
        await new Promise(r => setTimeout(r, 1000));
        try {
          return await client.lock(objectUrl);
        } catch {
          throw lockErr;
        }
      }
    }
    throw lockErr;
  }
}

// ============================================================================
// SAFETY GUARDS
// ============================================================================

function assertWriteEnabled(action = "Write"): void {
  if (!cfg.allowWrite)
    throw new McpError(ErrorCode.InvalidRequest,
      `${action} ist deaktiviert. ALLOW_WRITE=true in .env setzen. ` +
      "⚠️  Nur auf DEV-Systemen aktivieren!");
}

function assertDeleteEnabled(): void {
  if (!cfg.allowDelete)
    throw new McpError(ErrorCode.InvalidRequest,
      "Löschen ist deaktiviert. ALLOW_DELETE=true in .env setzen. ⚠️  Nicht rückgängig machbar!");
}

function assertPackageAllowed(devClass: string): void {
  const upper = devClass.toUpperCase();
  const blocked = cfg.blockedPackages.find(p => upper.startsWith(p));
  if (blocked)
    throw new McpError(ErrorCode.InvalidRequest,
      `Package '${devClass}' ist gesperrt (Prefix '${blocked}' in BLOCKED_PACKAGES).`);
}

function assertCustomerNamespace(name: string, prefix: string[]): void {
  const upper = name.toUpperCase();
  if (!prefix.some(p => upper.startsWith(p)))
    throw new McpError(ErrorCode.InvalidRequest,
      `Name '${name}' muss mit ${prefix.join(" oder ")} beginnen (Customer Namespace).`);
}

function assertSelectOnly(query: string): void {
  const trimmed = query.trim();
  if (!/^SELECT\s/i.test(trimmed) || /[;.]\s*(INSERT|UPDATE|DELETE|MODIFY|COMMIT)\s/i.test(trimmed))
    throw new McpError(ErrorCode.InvalidRequest,
      "Nur SELECT-Statements sind erlaubt. Die Query muss mit 'SELECT' beginnen und darf keine DML-Anweisungen enthalten.");
}

// ============================================================================
// ZOD SCHEMAS — alle Tool-Parameter
// ============================================================================

// --- SEARCH ---
const S_Search = z.object({
  query:       z.string().describe("Namensmuster, Wildcards * möglich, z.B. 'ZCL_*SERVICE*'"),
  maxResults:  z.number().int().min(1).max(100).default(20).optional(),
  objectType:  z.string().optional().describe(
    "ADT-Typ, z.B. PROG/P | CLAS/OC | FUGR/F | INTF/OI | DDLS/DF | TABL/DT | DOMA/DE | DTEL/DE | MSAG/E | SICF/SC. Leer = alle Typen."
  ),
});

// --- READ ---
const S_ReadSource = z.object({
  objectUrl: z.string().describe("ADT-URL, z.B. /sap/bc/adt/programs/programs/ztest"),
  includeRelated: z.boolean().default(false).optional().describe(
    "Wenn true, werden automatisch alle zugehörigen Objekte mitgelesen: " +
    "Klassen-Includes (Definitionen, Implementierungen, Macros, Testklassen), " +
    "Programm-Includes (INCLUDE-Anweisungen), Funktionsgruppen-Includes. " +
    "Empfohlen um den vollständigen Kontext eines Objekts zu verstehen."
  ),
});
const S_ObjectInfo = z.object({
  objectUrl: z.string().describe("ADT-URL des Objekts"),
});
const S_WhereUsed = z.object({
  objectUrl:  z.string().describe("ADT-URL des gesuchten Objekts"),
  maxResults: z.number().int().min(1).max(200).default(50).optional(),
});
const S_CodeCompletion = z.object({
  objectUrl:   z.string().describe("ADT-URL des Objekts (Kontext für Vervollständigung)"),
  source:      z.string().describe("Aktueller Quellcode mit Cursor-Position"),
  line:        z.number().int().min(1).describe("Zeile des Cursors (1-basiert)"),
  column:      z.number().int().min(0).describe("Spalte des Cursors (0-basiert)"),
});

// --- WRITE ---
const S_WriteSource = z.object({
  objectUrl:        z.string().describe("ADT-URL ohne /source/main Suffix"),
  source:           z.string().describe("Vollständiger ABAP-Quellcode"),
  transport:        z.string().optional().describe("Transportauftrag, z.B. DEVK900123"),
  activateAfterWrite: z.boolean().default(true).optional().describe("Nach dem Schreiben aktivieren (Default: true)"),
  skipSyntaxCheck:  z.boolean().default(false).optional().describe("Syntaxcheck überspringen (nicht empfohlen)"),
  mainProgram:      z.string().optional().describe("Hauptprogramm für Syntaxcheck bei Includes — Name (z.B. ZRYBAK_AI_TEST) oder ADT-URL"),
});
const S_Activate = z.object({
  objectUrl:  z.string().describe("ADT-URL des Objekts"),
  objectName: z.string().describe("Objektname, z.B. ZTEST oder ZCL_FOO"),
});
const S_MassActivate = z.object({
  objects: z.array(z.object({
    objectUrl:  z.string().describe("ADT-URL"),
    objectName: z.string().describe("Objektname"),
    objectType: z.string().optional().describe("ADT-Typ, z.B. PROG/P, PROG/I, CLAS/OC (optional, wird aus URL hergeleitet)"),
  })).describe("Liste der zu aktivierenden Objekte (max. 50)"),
});
const S_PrettyPrint = z.object({
  source:      z.string().describe("ABAP-Quellcode der formatiert werden soll"),
  objectUrl:   z.string().optional().describe("ADT-URL (für Kontext, optional)"),
});

// --- CREATE ---
const S_CreateProgram = z.object({
  name:        z.string().min(1).max(30).describe("Programmname, muss mit Z oder Y beginnen"),
  description: z.string().max(40).describe("Kurztext (max 40 Zeichen)"),
  devClass:    z.string().describe("Paket, z.B. ZLOCAL oder $TMP"),
  transport:   z.string().optional().describe("Transportauftrag (leer für lokale Objekte)"),
  programType: z.enum(["P", "I"]).default("P").optional().describe("P = Executable (Report), I = Include (Default: P)"),
});
const S_CreateClass = z.object({
  name:        z.string().min(1).max(30).describe("Klassenname, muss mit ZCL_ oder YCL_ beginnen"),
  description: z.string().max(40).describe("Kurztext"),
  devClass:    z.string().describe("Paket"),
  transport:   z.string().optional(),
  superClass:  z.string().optional().describe("Superklasse, z.B. CL_ABAP_UNIT_ASSERT"),
});
const S_CreateInterface = z.object({
  name:        z.string().min(1).max(30).describe("Interfacename, muss mit ZIF_ oder YIF_ beginnen"),
  description: z.string().max(40).describe("Kurztext"),
  devClass:    z.string().describe("Paket"),
  transport:   z.string().optional(),
});
const S_CreateFunctionGroup = z.object({
  name:        z.string().min(1).max(26).describe("FuGr-Name, muss mit Z oder Y beginnen"),
  description: z.string().max(40).describe("Kurztext"),
  devClass:    z.string().describe("Paket"),
  transport:   z.string().optional(),
});
const S_CreateCdsView = z.object({
  name:        z.string().min(1).max(30).describe("CDS-Name, muss mit Z oder Y beginnen"),
  description: z.string().max(40).describe("Kurztext"),
  devClass:    z.string().describe("Paket"),
  transport:   z.string().optional(),
});
const S_CreateTable = z.object({
  name:        z.string().min(1).max(16).describe("Tabellenname, muss mit Z oder Y beginnen"),
  description: z.string().max(40).describe("Kurztext"),
  devClass:    z.string().describe("Paket"),
  transport:   z.string().optional(),
});
const S_CreateMessageClass = z.object({
  name:        z.string().min(1).max(20).describe("Message-Class-Name, muss mit Z oder Y beginnen"),
  description: z.string().max(40).describe("Kurztext"),
  devClass:    z.string().describe("Paket"),
  transport:   z.string().optional(),
});

// --- DELETE ---
const S_DeleteObject = z.object({
  objectUrl:  z.string().describe("ADT-URL des zu löschenden Objekts"),
  objectName: z.string().describe("Objektname (zur Bestätigung)"),
  transport:  z.string().optional().describe("Transportauftrag"),
});

// --- TEST ---
const S_RunTests = z.object({
  objectUrl: z.string().describe("ADT-URL der Klasse oder des Programms"),
});
const S_CreateTestInclude = z.object({
  classUrl: z.string().describe("ADT-URL der Klasse, z.B. /sap/bc/adt/oo/classes/zcl_foo"),
});

// --- QUALITY ---
const S_SyntaxCheck = z.object({
  objectUrl:   z.string().describe("ADT-URL des Objekts"),
  source:      z.string().describe("ABAP-Quellcode"),
  mainProgram: z.string().optional().describe("Hauptprogramm (für Includes) — Name oder ADT-URL"),
});
const S_RunAtc = z.object({
  objectUrl:  z.string().describe("ADT-URL des zu prüfenden Objekts"),
  checkVariant: z.string().default("DEFAULT").optional().describe("ATC-Prüfvariante (Default: DEFAULT)"),
});

// --- DIAGNOSTICS ---
const S_GetDumps = z.object({
  maxResults: z.number().int().min(1).max(100).default(20).optional(),
  user:       z.string().optional().describe("Auf User einschränken"),
  since:      z.string().optional().describe("Zeitfilter ISO-8601, z.B. 2025-01-01T00:00:00Z"),
});
const S_GetDumpDetail = z.object({
  dumpId: z.string().describe("Dump-ID aus get_short_dumps"),
});
const S_GetTraces = z.object({
  maxResults: z.number().int().min(1).max(50).default(10).optional(),
  user:       z.string().optional().describe("Auf User einschränken"),
});
const S_GetTraceDetail = z.object({
  traceId: z.string().describe("Trace-ID aus get_traces"),
});

// --- TRANSPORT ---
const S_TransportInfo = z.object({
  objectUrl: z.string().describe("ADT-URL des Objekts"),
  devClass:  z.string().describe("Paket des Objekts"),
});
const S_TransportObjects = z.object({
  transportId: z.string().describe("Transportauftrag, z.B. DEVK900123"),
});

// --- ABAPGIT ---
const S_GitRepos = z.object({
  objectUrl: z.string().optional().describe("Systemverbindungs-URL (leer = aktives System)"),
});
const S_GitPull = z.object({
  repoId:    z.string().describe("abapGit Repository-ID"),
  transport: z.string().optional().describe("Transportauftrag für Pull"),
});

// --- QUERY ---
const S_Query = z.object({
  query: z.string().describe("SELECT-Statement, z.B. SELECT * FROM T001 UP TO 10 ROWS"),
});

// --- NEW TOOLS ---
const S_FindDefinition = z.object({
  objectUrl:   z.string().describe("ADT-URL des Quellobjekts (Kontext)"),
  source:      z.string().describe("Aktueller Quellcode"),
  line:        z.number().int().min(1).describe("Zeile des Tokens (1-basiert)"),
  startColumn: z.number().int().min(0).describe("Startspalte des Tokens (0-basiert)"),
  endColumn:   z.number().int().min(0).describe("Endspalte des Tokens (0-basiert)"),
  mainProgram: z.string().optional().describe("Hauptprogramm (bei Includes)"),
});
const S_GetRevisions = z.object({
  objectUrl: z.string().describe("ADT-URL des Objekts"),
});
const S_CreateTransport = z.object({
  objectUrl:      z.string().describe("ADT-URL des Objekts"),
  description:    z.string().max(60).describe("Beschreibungstext des Transports"),
  devClass:       z.string().describe("Paket"),
  transportLayer: z.string().optional().describe("Transport-Layer (optional)"),
});
const S_FixProposals = z.object({
  objectUrl:   z.string().describe("ADT-URL des Objekts"),
  source:      z.string().describe("Aktueller Quellcode"),
  line:        z.number().int().min(1).describe("Zeile des Fehlers (1-basiert)"),
  column:      z.number().int().min(0).describe("Spalte des Fehlers (0-basiert)"),
});
const S_GetDdicElement = z.object({
  path: z.string().describe("DDIC-Pfad, z.B. Tabellenname oder CDS-View-Name"),
});
const S_GetInactiveObjects = z.object({});
const S_GetTableContents = z.object({
  tableName: z.string().describe("Name der DDIC-Tabelle"),
  maxRows:   z.number().int().min(1).max(1000).default(100).optional().describe("Max. Anzahl Zeilen (Default: 100)"),
});

// --- CONTEXT ANALYSIS ---
const S_AnalyzeContext = z.object({
  objectUrl: z.string().describe("ADT-URL des Haupt-Objekts"),
  depth: z.enum(["shallow", "deep"]).default("deep").optional()
    .describe("shallow = nur Hauptquelle + direkte Includes; deep = rekursiv alle Referenzen"),
});

// --- DOCUMENTATION ---
const S_GetAbapKeywordDoc = z.object({
  keyword: z.string().describe("ABAP-Keyword (z.B. SELECT, LOOP, READ TABLE, MODIFY)"),
  version: z.string().optional().describe("ABAP-Version (z.B. 'latest', '758', '754'). Default: cfg.sapAbapVersion"),
});
const S_GetAbapClassDoc = z.object({
  className: z.string().describe("ABAP-Klassenname oder Interface (z.B. CL_SALV_TABLE, IF_AMDP_MARKER_HDB)"),
  version: z.string().optional().describe("ABAP-Version (z.B. 'latest', '758', '754'). Default: cfg.sapAbapVersion"),
});
const S_GetModuleBestPractices = z.object({
  module: z.enum(["FI", "CO", "MM", "SD", "PP", "PM", "QM", "HR", "HCM", "PS", "WM", "EWM", "BASIS", "BC", "ABAP"])
    .describe("SAP-Modul (z.B. FI, MM, SD, ABAP)"),
});

// ============================================================================
// HELPER: Zod → JSON Schema (minimal inline converter)
// ============================================================================

function toJsonSchema(schema: z.ZodTypeAny): object {
  function c(s: z.ZodTypeAny): object {
    if (s instanceof z.ZodObject) {
      const properties: Record<string, object> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(s.shape as Record<string, z.ZodTypeAny>)) {
        properties[k] = c(v as z.ZodTypeAny);
        if (!(v instanceof z.ZodOptional) && !(v instanceof z.ZodDefault)) required.push(k);
      }
      return { type: "object", properties, ...(required.length ? { required } : {}) };
    }
    const desc = (t: z.ZodTypeAny) => t._def.description ? { description: t._def.description } : {};
    if (s instanceof z.ZodArray)   return { type: "array", items: c(s.element), ...desc(s) };
    if (s instanceof z.ZodOptional) return c(s.unwrap());
    if (s instanceof z.ZodDefault)  return c(s._def.innerType);
    if (s instanceof z.ZodEnum)     return { type: "string", enum: s.options, ...desc(s) };
    if (s instanceof z.ZodString)   return { type: "string", ...desc(s) };
    if (s instanceof z.ZodNumber)   return { type: "number", ...desc(s) };
    if (s instanceof z.ZodBoolean)  return { type: "boolean", ...desc(s) };
    return {};
  }
  return c(schema);
}

// ============================================================================
// HELPER — normalize mainProgram: accept both name and URL
// ============================================================================

function resolveMainProgram(mainProgram: string | undefined): string | undefined {
  if (!mainProgram) return undefined;
  // Already a URL — use as-is
  if (mainProgram.startsWith("/")) return mainProgram;
  // Plain program name → convert to ADT URL
  return `/sap/bc/adt/programs/programs/${mainProgram.toLowerCase()}`;
}

// ============================================================================
// DOCUMENTATION HELPERS — fetch SAP help.sap.com pages
// ============================================================================

async function fetchSapDocumentation(url: string): Promise<{ success: boolean; content: string; url: string }> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { "Accept": "text/html", "User-Agent": "ABAP-MCP-Server/2.0" },
    });
    if (!resp.ok) return { success: false, content: `HTTP ${resp.status}`, url };
    const html = await resp.text();
    return { success: true, content: extractMainContent(html), url };
  } catch (e) {
    return { success: false, content: (e as Error).message, url };
  }
}

function extractMainContent(html: string): string {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : "";

  // Try to extract main content area
  let content = "";
  const contentMatch = html.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<div[^>]*class="[^"]*footer)/i)
    ?? html.match(/<section[^>]*>([\s\S]*?)<\/section>/i)
    ?? html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (contentMatch) content = contentMatch[1];
  else content = html;

  // HTML → Markdown-like conversion
  content = content
    // Remove script/style blocks
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    // Headers
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n")
    // Code blocks
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```abap\n$1\n```\n")
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    // Bold/italic
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**")
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**")
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "*$1*")
    // Lists
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n")
    // Line breaks / paragraphs
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<p[^>]*>/gi, "")
    // Tables: simple row extraction
    .replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_, row: string) => {
      const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => m[1].trim());
      return cells.join(" | ") + "\n";
    })
    // Remove remaining HTML tags
    .replace(/<[^>]+>/g, "")
    // Decode entities
    .replace(/&nbsp;/g, " ");

  content = decodeHtmlEntities(content);

  // Normalize whitespace
  content = content
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Truncate to ~8000 chars
  if (content.length > 8000) {
    content = content.substring(0, 8000) + "\n\n... (gekuerzt)";
  }

  return title ? `# ${title}\n\n${content}` : content;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function buildKeywordUrl(keyword: string, version: string): string {
  const v = version === "latest" ? "latest" : version;
  const kw = keyword.toLowerCase().replace(/[\s-]+/g, "");
  return `https://help.sap.com/doc/abapdocu_${v}_index_htm/${v}/en-US/abap${kw}.htm`;
}

function buildClassUrl(className: string, version: string): string {
  const v = version === "latest" ? "latest" : version;
  const cn = className.toLowerCase().replace(/[\s]+/g, "");
  return `https://help.sap.com/doc/abapdocu_${v}_index_htm/${v}/en-US/aben${cn}.htm`;
}

// ============================================================================
// MODULE BEST PRACTICES
// ============================================================================

const MODULE_BEST_PRACTICES: Record<string, string> = {
  FI: `# SAP FI (Financial Accounting) — Best Practices

## Wichtige Tabellen & Strukturen
- BKPF/BSEG — Belegkopf/-positionen
- BSID/BSAD — Debitoreneinzelposten (offen/ausgeglichen)
- BSIK/BSAK — Kreditoreneinzelposten (offen/ausgeglichen)
- SKA1/SKB1 — Sachkonten (Plan/Buchungskreis)
- T001 — Buchungskreise

## Empfohlene BAPIs & Klassen
- BAPI_ACC_DOCUMENT_POST — Buchungsbelege erfassen (statt FB01 direkt)
- BAPI_ACC_DOCUMENT_REV_POST — Storno
- CL_ACC_DOCUMENT — OO-API für Belege (S/4HANA)
- BAPI_COMPANYCODE_GETLIST — Buchungskreise lesen

## Coding-Richtlinien
- NIE direkt in BKPF/BSEG schreiben — immer BAPIs oder ACC-Klassen verwenden
- Buchungslogik über BAPI_ACC_DOCUMENT_POST, nicht BDC auf FB01
- Steuerberechnung dem System überlassen (CALCULATE_TAX_FROM_NET_AMOUNT)
- Währungsumrechnung: CONVERT_TO_LOCAL_CURRENCY

## Häufige Fehler
- Direkte BSEG-Selects ohne Index → Performance-Probleme (BSEG ist Cluster-Tabelle!)
- In S/4HANA: BSEG ist View auf ACDOCA → SELECT auf ACDOCA nutzen
- Fehlende BAPI_TRANSACTION_COMMIT nach BAPI-Aufrufen
- Währungsfelder ohne Referenz auf Währungsschlüssel

## S/4HANA-Migration
- BSEG → ACDOCA (Universal Journal)
- Neue CDS Views: I_JournalEntry, I_OperationalAcctgDocItem
- FAGL_SPLITTER ersetzt klassisches Splitting`,

  CO: `# SAP CO (Controlling) — Best Practices

## Wichtige Tabellen & Strukturen
- CSKS/CSKT — Kostenstellen (Stamm/Texte)
- CSKA/CSKB — Kostenarten
- COBK/COEP — CO-Belegkopf/-positionen
- COSS/COSP — Summen Stat./Plan
- AUFK — Innenaufträge

## Empfohlene BAPIs & Klassen
- BAPI_COSTCENTER_GETLIST — Kostenstellen lesen
- BAPI_INTERNALORDER_GETLIST — Aufträge lesen
- K_ORDER_READ — Auftragsdaten lesen
- BAPI_ACC_ACTIVITY_ALLOC_POST — Leistungsverrechnung

## Coding-Richtlinien
- CO-Buchungen immer über BAPIs, nie direkt auf COEP
- Kostenstellenhierarchien über SET-Funktionsbausteine lesen
- Planwerte über BAPI_COSTCENTER_PLAN_POST
- CO-PA: COPA_FUNCTION_MODULE-Aufrufe für Ergebnisobjekte

## Häufige Fehler
- Fehlende Berechtigung auf CO-Objekte (Kostenrechnungskreis)
- Periodenabgrenzung nicht beachtet bei Reports
- CO-PA-Merkmale falsch zugeordnet

## S/4HANA-Migration
- CO-Belege in ACDOCA integriert
- CDS Views: I_CostCenter, I_InternalOrder
- Embedded Analytics statt Report Painter/Writer`,

  MM: `# SAP MM (Materials Management) — Best Practices

## Wichtige Tabellen & Strukturen
- MARA/MAKT/MARC/MARD — Materialstamm
- EKKO/EKPO — Bestellkopf/-positionen
- EBAN — Bestellanforderungen
- MKPF/MSEG — Materialbelege
- MCHB — Chargenbestände

## Empfohlene BAPIs & Klassen
- BAPI_PO_CREATE1 — Bestellung anlegen
- BAPI_PR_CREATE — Bestellanforderung anlegen
- BAPI_MATERIAL_GET_DETAIL — Materialstamm lesen
- BAPI_GOODSMVT_CREATE — Warenbewegung buchen
- CL_EXITHANDLER — BAdI-Implementierungen für MM-Erweiterungen

## Coding-Richtlinien
- Materialstamm lesen: BAPI_MATERIAL_GET_DETAIL oder SELECT auf MARA mit Buffering
- Bestellungen: BAPI_PO_CREATE1 (nie ME_CREATE_PO direkt)
- Warenbewegungen: BAPI_GOODSMVT_CREATE mit GM_CODE
- Reservierungen: BAPI_RESERVATION_CREATE1

## Häufige Fehler
- SELECT * auf MSEG ohne Einschränkung → riesige Datenmengen
- Fehlende COMMIT WORK nach BAPI-Aufrufen
- Mengeneinheit-Konvertierung vergessen (UNIT_CONVERSION_SIMPLE)

## S/4HANA-Migration
- MARD vereinfacht (kein LQUA mehr direkt)
- MATDOC ersetzt MKPF/MSEG für neue Belege
- CDS Views: I_PurchaseOrderAPI01, I_Material`,

  SD: `# SAP SD (Sales & Distribution) — Best Practices

## Wichtige Tabellen & Strukturen
- VBAK/VBAP — Kundenauftragskopf/-positionen
- LIKP/LIPS — Lieferungskopf/-positionen
- VBRK/VBRP — Fakturakopf/-positionen
- KNA1/KNVV — Debitorenstamm
- KONV — Konditionen

## Empfohlene BAPIs & Klassen
- BAPI_SALESORDER_CREATEFROMDAT2 — Kundenauftrag anlegen
- BAPI_DELIVERY_GETLIST — Lieferungen lesen
- BAPI_BILLINGDOC_CREATEMULTIPLE — Faktura anlegen
- SD_SALESDOCUMENT_CREATE — neuere API

## Coding-Richtlinien
- Aufträge über BAPIs anlegen, nicht BDC auf VA01
- Preisfindung: Pricing-BAdIs nutzen, nicht KONV direkt ändern
- Verfügbarkeit: ATP-Funktionsbausteine (AVAILABILITY_CHECK)
- Partnerfindung: Standard-Partnerschema respektieren

## Häufige Fehler
- VBAP-SELECT ohne Auftragsart-Einschränkung → Performance
- Konditionstechnik umgehen statt richtig konfigurieren
- Fehlende Berechtigungsprüfungen auf Verkaufsorganisation

## S/4HANA-Migration
- CDS Views: I_SalesOrder, I_SalesOrderItem, I_BillingDocument
- Credit Management über SAP Credit Management (FIN-FSCM-CR)
- Output Management über BRF+`,

  PP: `# SAP PP (Production Planning) — Best Practices

## Wichtige Tabellen & Strukturen
- AFKO/AFPO — Fertigungsauftragskopf/-positionen
- AFVC/AFVV — Vorgänge/Vorgangswerte
- STKO/STPO — Stücklisten
- PLKO/PLPO — Arbeitspläne
- RESB — Reservierungen

## Empfohlene BAPIs & Klassen
- BAPI_PRODORD_CREATE — Fertigungsauftrag anlegen
- BAPI_PRODORD_RELEASE — Auftrag freigeben
- BAPI_GOODSMVT_CREATE — Rückmeldung/Warenbewegung
- CS_BOM_EXPL_MAT_V2 — Stücklistenauflösung

## Coding-Richtlinien
- Fertigungsaufträge: BAPIs verwenden, nicht CO01-BDC
- Stücklisten: CS_BOM_EXPL_MAT_V2 für Auflösung
- Kapazitätsplanung: Standard-FBs nutzen
- Rückmeldungen: BAPI_PRODORDCONF_CREATE_TT

## Häufige Fehler
- Stücklistenauflösung ohne Stichtag
- Fehlende Statusprüfung vor Auftragsoperationen
- Performance bei massenhafter Stücklistenauflösung

## S/4HANA-Migration
- CDS Views: I_ProductionOrder, I_ManufacturingOrder
- PP/DS ersetzt teilweise klassische Planung`,

  PM: `# SAP PM (Plant Maintenance) — Best Practices

## Wichtige Tabellen & Strukturen
- EQUI/EQKT — Equipment
- IFLO/IFLOT — Technische Plätze
- AUFK — PM-Aufträge
- AFIH — Instandhaltungskopf
- QMEL — Meldungen

## Empfohlene BAPIs & Klassen
- BAPI_EQUI_CREATE — Equipment anlegen
- BAPI_ALM_ORDER_MAINTAIN — PM-Auftrag pflegen
- BAPI_ALM_NOTIF_CREATE — Meldung anlegen
- BAPI_FUNCLOC_CREATE — Technischen Platz anlegen

## Coding-Richtlinien
- PM-Aufträge: BAPI_ALM_ORDER_MAINTAIN (Multi-Step)
- Meldungen: BAPI_ALM_NOTIF_* Familie
- Klassifizierung: BAPI_CLASSIFICATION_*
- Messdokumente: MEASUREM_DOCUM_RFC_SINGLE_001

## Häufige Fehler
- Fehlende Partnerpflege bei Aufträgen
- Statusnetz nicht beachtet
- Equipment-Hierarchie fehlerhaft aufgebaut

## S/4HANA-Migration
- Asset Management Integration
- CDS Views: I_MaintenanceOrder, I_FunctionalLocation`,

  QM: `# SAP QM (Quality Management) — Best Practices

## Wichtige Tabellen & Strukturen
- QALS — Prüflose
- QASR — Stichprobenergebnisse
- QAVE — Verwendungsentscheide
- QMEL — Qualitätsmeldungen
- QMFE — Fehler/Ursachen

## Empfohlene BAPIs & Klassen
- BAPI_QUALNOT_CREATE — Qualitätsmeldung anlegen
- BAPI_INSPLOT_GETLIST — Prüflose lesen
- QM_INSPECTION_LOT_CREATE — Prüflos anlegen

## Coding-Richtlinien
- Prüflose nicht manuell erzeugen wenn automatische Losöffnung konfiguriert
- Verwendungsentscheide: Standard-Workflow nutzen
- Kataloge für Fehlerarten konsequent pflegen

## Häufige Fehler
- Prüfpunkt-Zuordnung in Arbeitsplänen vergessen
- QM-Berechtigungen zu restriktiv/zu offen
- Fehlende Dynamisierungsregeln bei Stichproben

## S/4HANA-Migration
- Eingebettetes QM in S/4HANA Manufacturing
- CDS Views: I_InspectionLot, I_QualityNotification`,

  HR: `# SAP HR/HCM (Human Capital Management) — Best Practices

## Wichtige Tabellen & Strukturen
- PA0001-PA0999 — Personalstamm-Infotypen
- HRP1000/HRP1001 — OM-Objekte/Verknüpfungen
- PCL1/PCL2 — Abrechnungscluster
- PERNR — Personalnummer (zentrale Entität)

## Empfohlene BAPIs & Klassen
- HR_READ_INFOTYPE — Infotyp lesen (Standard-FB)
- HR_INFOTYPE_OPERATION — Infotyp pflegen (INSS/MOD/DEL)
- RH_READ_OBJECT — OM-Objekte lesen
- CL_HR_PA_REQUEST_API — PA-Maßnahmen (neuere API)

## Coding-Richtlinien
- Infotypen: IMMER HR_READ_INFOTYPE / MACROS (RP-READ-INFOTYPE)
- NIE direkt auf PA-Tabellen schreiben!
- Berechtigungen: HR-Auth über PERNR + INFTY + SUBTY prüfen
- Logische Datenbank PNP/PNPCE für Reports nutzen
- Zeitwirtschaft: Schemas über PCRs anpassen, nicht hart codieren

## Häufige Fehler
- SELECT auf PA-Tabellen ohne Begda/Endda-Logik
- Cluster-Tabellen (PCL*) direkt lesen statt über Makros
- Fehlende Berücksichtigung von Gültigkeitszeiträumen
- MOLGA-abhängige Logik nicht berücksichtigt

## S/4HANA-Migration
- SAP SuccessFactors für Cloud-HCM
- On-Premise: HCM for S/4HANA (Kompatibilitätspaket)
- Employee Central als Master für Stammdaten`,

  PS: `# SAP PS (Project System) — Best Practices

## Wichtige Tabellen & Strukturen
- PROJ — Projektdefinition
- PRPS — PSP-Elemente
- AUFK — PS-Netzpläne/Aufträge
- AFVC — Vorgänge
- BPGE/BPJA — Budgetwerte

## Empfohlene BAPIs & Klassen
- BAPI_PS_INITIALIZATION — PS-APIs initialisieren
- BAPI_PS_CREATE_WBS_ELEMENT — PSP-Element anlegen
- BAPI_NETWORK_MAINTAIN — Netzplan pflegen
- BAPI_PROJECT_MAINTAIN — Projekt pflegen

## Coding-Richtlinien
- PS-APIs immer im Buffer-Modus (INIT → Operationen → SAVE)
- Projekthierarchie: Top-Down aufbauen
- Budget: Über BAPIs, nicht direkt auf BPGE
- Terminierung: Standard-Terminierungsfunktionen nutzen

## Häufige Fehler
- BAPI_PS_PRECOMMIT vor BAPI_TRANSACTION_COMMIT vergessen
- Hierarchie-Ebenen durcheinander
- Statusprofil nicht berücksichtigt

## S/4HANA-Migration
- Commercial Project Management (CPM)
- CDS Views: I_Project, I_WBSElement`,

  WM: `# SAP WM/EWM (Warehouse Management) — Best Practices

## Wichtige Tabellen & Strukturen
- LQUA — Quants (Lagerbestände)
- LTAP/LTAK — Transportaufträge
- LAGP — Lagerplätze
- T300/T301 — Lager-/Lagertyp-Customizing
- LEIN — Lagereinheiten

## Empfohlene BAPIs & Klassen
- BAPI_WHSE_TO_CREATE_STOCK — Transportauftrag anlegen
- L_TO_CREATE_MOVE_SU — TA für Lagereinheit
- BAPI_WHSE_STOCK_GET_LIST — Bestände lesen

## Coding-Richtlinien
- Transportaufträge: Immer über BAPIs/Standard-FBs
- Lagerplatzfindung: Putaway-Strategien konfigurieren, nicht hart codieren
- Inventur: Standard-Transaktionen MI*/LI* nutzen

## Häufige Fehler
- Quant-Tabelle (LQUA) direkt modifizieren
- Fehlende Quittierung von Transportaufträgen
- WM-MM-Integration: Bestandsdifferenzen durch fehlende TA-Quittierung

## S/4HANA-Migration
- WM → EWM (Embedded oder Dezentral)
- Stock Room Management als einfache Alternative
- EWM: /SCWM/ Namespace, CDS Views verfügbar`,

  EWM: `# SAP EWM (Extended Warehouse Management) — Best Practices

## Wichtige Tabellen & Strukturen
- /SCWM/AQUA — Quants
- /SCWM/ORDIM_O — Warehouse Tasks
- /SCWM/LAGP — Storage Bins
- /SCWM/WHO — Warehouse Orders

## Empfohlene Klassen
- /SCWM/CL_WM_PACKING — Packlogik
- /SCWM/CL_SR_BOM — Stücklisten im Lager
- PPF (Post Processing Framework) für Automatisierung

## Coding-Richtlinien
- BAdIs für Prozessanpassungen (z.B. /SCWM/EX_HUOPT)
- Warehouse Tasks über Standard-APIs erstellen
- RF-Framework für mobile Dialoge nutzen

## Häufige Fehler
- Direkte Tabellenmanipulation statt API-Nutzung
- EWM-ERP-Integration: IDoc-Verarbeitung nicht überwacht
- Fehlende Exception Handling bei /SCWM/-APIs

## S/4HANA-Migration
- Embedded EWM direkt in S/4HANA verfügbar
- Dezentrales EWM für komplexe Szenarien`,

  BASIS: `# SAP BASIS/BC — Best Practices

## Wichtige Tabellen & Strukturen
- USR02 — Benutzerstamm
- TVARVC — Selektionsvariablen
- TBTCO/TBTCP — Job-Übersicht
- E070/E071 — Transporte
- TADIR — Objektkatalog

## Empfohlene Klassen & FBs
- CL_LOG_PPF — Application Log
- BAL_LOG_CREATE / BAL_LOG_MSG_ADD — Application Log (klassisch)
- JOB_OPEN / JOB_SUBMIT / JOB_CLOSE — Hintergrundverarbeitung
- CL_BCS — Business Communication Services (E-Mail)
- CL_GUI_FRONTEND_SERVICES — Datei-Up/Download

## Coding-Richtlinien
- Logging: Application Log (BAL) oder CL_LOG_PPF nutzen, nicht WRITE
- Jobs: JOB_OPEN/SUBMIT/CLOSE für Hintergrundverarbeitung
- Berechtigungen: AUTHORITY-CHECK immer mit spezifischen Objekten
- Konfiguration: TVARVC für variable Parameter statt Hardcoding
- Sperren: Enqueue/Dequeue FBs für eigene Sperrobjekte

## Häufige Fehler
- AUTHORITY-CHECK vergessen oder zu generisch
- Sperrobjekte nicht freigegeben (Enqueue ohne Dequeue)
- Hardcodierte Mandanten/Systemnummern
- COMMIT WORK in Update-Task-FBs

## S/4HANA-Migration
- ABAP Platform: Cloud-fähiges ABAP
- Released APIs beachten (Whitelist)
- CL_ABAP_CONTEXT_INFO statt SY-UNAME/SY-DATUM direkt`,

  ABAP: `# ABAP — Allgemeine Best Practices

## Clean ABAP Prinzipien
- Inline-Deklarationen: DATA(lv_var), FIELD-SYMBOL(<fs>)
- String Templates: |Text { lv_var }| statt CONCATENATE
- NEW #() / VALUE #() / CONV #() — Constructor Expressions
- COND #() / SWITCH #() statt IF/CASE für Zuweisungen
- REDUCE #() für Aggregationen
- FILTER #() statt LOOP + IF

## Moderne ABAP SQL
- SELECT ... INTO TABLE @DATA(lt_result) — Host-Variablen mit @
- SELECT ... FROM ... JOIN — statt FOR ALL ENTRIES
- CDS Views für komplexe Abfragen
- ABAP SQL Aggregationen statt ABAP LOOP + COLLECT

## OOP-Richtlinien
- Klassen/Interfaces statt Funktionsbausteine für neue Logik
- Dependency Injection über Interfaces (Testbarkeit)
- SOLID-Prinzipien beachten
- Ausnahmen: CX_*-Klassen, TRY/CATCH statt SY-SUBRC

## Performance
- SELECT nur benötigte Felder, nie SELECT *
- Interne Tabellen: SORTED/HASHED TABLE für häufige Zugriffe
- PARALLEL CURSOR für verschachtelte LOOPs
- Pufferung: Tabellenpufferung konfigurieren, Single-Record-Buffer nutzen
- FOR ALL ENTRIES: Duplikate und leere Tabelle prüfen!

## Vermeidung obsoleter Anweisungen
- MOVE → = (Zuweisung)
- COMPUTE → direkte Berechnung
- CHECK in Methoden → IF + RETURN
- FORM/PERFORM → Methoden
- Kopfzeilen-Tabellen → separate Workarea

## Testbarkeit
- ABAP Unit: CL_ABAP_UNIT_ASSERT
- Test-Doubles: CL_ABAP_TESTDOUBLE
- Test-Seams: IF_OSQL_TEST_ENVIRONMENT für DB
- SQL Test Double Framework

## S/4HANA Kompatibilität
- Released APIs prüfen (Whitelist-Ansatz)
- CL_ABAP_CONTEXT_INFO nutzen
- RAP (RESTful ABAP Programming) für neue Apps
- CDS Views als zentrale Datenmodelle`,
};

// Aliases: HCM → HR, BC → BASIS
MODULE_BEST_PRACTICES["HCM"] = MODULE_BEST_PRACTICES["HR"];
MODULE_BEST_PRACTICES["BC"] = MODULE_BEST_PRACTICES["BASIS"];

// ============================================================================
// WRITE SOURCE WORKFLOW (lock → write → check → activate → unlock)
// ============================================================================

function formatActivationMessages(messages: ActivationResultMessage[]): string[] {
  return messages.map(m =>
    `  [${m.type}] ${m.shortText}${m.line ? ` (Zeile ${m.line})` : ""}${m.objDescr ? ` — ${m.objDescr}` : ""}`
  );
}

async function writeWorkflow(
  client: ADTClient,
  objectUrl: string,
  source: string,
  transport: string,
  activate: boolean,
  skipCheck: boolean,
  mainProgram?: string,
): Promise<{ success: boolean; log: string[]; syntaxErrors?: string[] }> {
  return withWriteLock(() => withStatefulSession(client, async () => {
    const log: string[] = [];
    let lockHandle: string | undefined;
    try {
      // Phase 1: lock → write → unlock (stateful session needed for lock/write)
      log.push(`🔒 Sperren: ${objectUrl}`);
      const lock = await lockWithRetry(client, objectUrl);
      lockHandle = lock.LOCK_HANDLE;
      if (!lockHandle) throw new Error("Lock fehlgeschlagen — kein Lock-Handle erhalten");
      log.push(`✅ Lock erhalten`);

      log.push(`✏️  Quellcode schreiben (${source.length} Zeichen)...`);
      const sourceUrl = objectUrl.endsWith("/source/main") ? objectUrl : `${objectUrl}/source/main`;
      await client.setObjectSource(sourceUrl, source, lockHandle, transport || undefined);
      log.push("✅ Quellcode gespeichert");

      // Unlock immediately after write — activation requires the object to be unlocked
      log.push("🔓 Lock freigeben...");
      try { await client.unLock(objectUrl, lockHandle); } catch { /* dropSession in finally will clean up */ }
      lockHandle = undefined;
      log.push("✅ Lock freigegeben");

      // Phase 2: syntax check + activate (no lock needed)
      if (!skipCheck) {
        log.push("🔍 Syntaxcheck...");
        const resolvedMain = resolveMainProgram(mainProgram) ?? objectUrl;
        try {
          const res = await client.syntaxCheck(objectUrl, resolvedMain, source);
          const errs = (Array.isArray(res) ? res : []).filter(
            (m: { severity: string }) => ["E", "A"].includes(m.severity));
          if (errs.length > 0) {
            const msgs = errs.map((e: { text: string; line?: number }) => `  Zeile ${e.line ?? "?"}: ${e.text}`);
            log.push(`❌ ${errs.length} Syntaxfehler — Code NICHT aktiviert.`);
            log.push("👉 Bitte korrigiere die Fehler und rufe write_abap_source erneut auf!");
            return { success: false, log, syntaxErrors: msgs };
          }
        } catch (syntaxErr) {
          log.push(`⚠️  Syntaxcheck-Aufruf fehlgeschlagen: ${String(syntaxErr instanceof Error ? syntaxErr.message : syntaxErr)}`);
          log.push("👉 Syntaxcheck übersprungen — Code wurde gespeichert. Bitte manuell prüfen.");
          return { success: false, log };
        }
        log.push("✅ Syntaxcheck OK");
      }

      if (activate) {
        log.push("🚀 Aktivieren...");
        const segments = objectUrl.replace(/[?#].*$/, "").split("/").filter(Boolean);
        const name = segments[segments.length - 1] ?? objectUrl;

        // Include-Programme brauchen das Hauptprogramm als Kontext für die Aktivierung,
        // da sie alleine nicht aktivierbar sind (referenzieren Variablen des Hauptprogramms).
        let activationContext: string | undefined;
        const isInclude = objectUrl.includes("/programs/includes/");
        if (isInclude) {
          const resolvedMain = resolveMainProgram(mainProgram);
          if (resolvedMain) {
            activationContext = resolvedMain;
            log.push(`📎 Include — Aktivierung im Kontext von: ${mainProgram}`);
          } else {
            // Hauptprogramm automatisch ermitteln
            try {
              const mains = await client.mainPrograms(objectUrl);
              if (mains.length > 0) {
                activationContext = mains[0]["adtcore:uri"];
                log.push(`📎 Include — Hauptprogramm automatisch ermittelt: ${mains[0]["adtcore:name"]}`);
              }
            } catch (mpErr) {
              log.push(`⚠️  Hauptprogramm konnte nicht ermittelt werden: ${String(mpErr instanceof Error ? mpErr.message : mpErr)}`);
            }
          }
        }

        const activationResult = await client.activate(name, objectUrl, activationContext);
        if (!activationResult.success) {
          const msgs = formatActivationMessages(activationResult.messages);
          log.push(`❌ Aktivierung fehlgeschlagen — Code wurde gespeichert aber NICHT aktiviert.`);
          if (msgs.length > 0) log.push(...msgs);
          log.push("👉 Bitte analysiere die Fehler, korrigiere den Code und rufe write_abap_source erneut auf!");
          return { success: false, log };
        }
        if (activationResult.messages.length > 0) {
          log.push("✅ Aktiviert (mit Hinweisen):");
          log.push(...formatActivationMessages(activationResult.messages));
        } else {
          log.push("✅ Aktiviert");
        }
      }

      return { success: true, log };
    } catch (err) {
      if (lockHandle) {
        try { await client.unLock(objectUrl, lockHandle); log.push("🔓 Lock nach Fehler freigegeben"); }
        catch { log.push("⚠️  Lock konnte nicht freigegeben werden — dropSession in finally wird aufräumen"); }
        lockHandle = undefined;
      }
      throw err;
    }
  }));
}

// ============================================================================
// TOOL DEFINITIONS (all 30+ tools)
// ============================================================================

interface ToolDef { name: string; description: string; schema: z.ZodTypeAny }

const TOOLS: ToolDef[] = [
  // ── SEARCH ─────────────────────────────────────────────────────────────
  { name: "search_abap_objects",
    description: "Suche nach ABAP-Objekten per Namensmuster. Wildcards (*) werden unterstützt. Liefert Name, Typ, ADT-URI und Paket. Unterstützt 30+ Objekttypen (Programme, Klassen, FuGr, CDS, Tabellen, Domain, Datenelement, Messages usw.).",
    schema: S_Search },

  // ── READ ────────────────────────────────────────────────────────────────
  { name: "read_abap_source",
    description: "Liest den Quellcode eines ABAP-Objekts. Mit includeRelated=true werden automatisch alle zugehörigen Objekte mitgelesen: Klassen-Includes (Definitionen, Implementierungen, Macros, Testklassen), Programm-Includes (INCLUDE-Anweisungen aufgelöst), Funktionsgruppen (alle Funktionsbausteine). Empfehlung: includeRelated=true nutzen um den vollständigen Kontext zu verstehen bevor Änderungen gemacht werden.",
    schema: S_ReadSource },
  { name: "get_object_info",
    description: "Liest detaillierte Metadaten und Struktur eines Objekts: Methoden, Attribute, Includes, Enqueue-Infos, DDIC-Felder usw.",
    schema: S_ObjectInfo },
  { name: "where_used",
    description: "Findet alle Verwendungsstellen eines Objekts im System (Programme, Klassen, andere Objekte). Basis für Impact-Analyse.",
    schema: S_WhereUsed },
  { name: "get_code_completion",
    description: "Holt Code-Vervollständigungsvorschläge vom SAP-System für eine bestimmte Cursor-Position. Liefert systemspezifische Vorschläge aus dem echten Kontext (Methodennamen, Attribute, Parameter usw.).",
    schema: S_CodeCompletion },

  // ── WRITE ───────────────────────────────────────────────────────────────
  { name: "write_abap_source",
    description: "Schreibt Quellcode in ein bestehendes ABAP-Objekt und aktiviert es. Führt automatisch den vollständigen ADT-Workflow aus: lock → write → syntax check → activate → unlock. " +
      "⚠️ WICHTIG: Nach dem Aufruf MUSS das Objekt aktiviert sein. Wenn Syntax- oder Aktivierungsfehler auftreten, analysiere die Fehlermeldungen, korrigiere den Quellcode und rufe write_abap_source erneut auf. " +
      "Wiederhole diesen Zyklus bis die Aktivierung erfolgreich ist. Gib niemals auf bevor der Code aktiviert ist! ⚠️ Erfordert ALLOW_WRITE=true.",
    schema: S_WriteSource },
  { name: "activate_abap_object",
    description: "Aktiviert ein bereits gespeichertes ABAP-Objekt. Nützlich nach manuellen Änderungen oder zur Reaktivierung nach Fehlern. ⚠️ Erfordert ALLOW_WRITE=true.",
    schema: S_Activate },
  { name: "mass_activate",
    description: "Aktiviert mehrere ABAP-Objekte in einem Schritt. Nützlich nach abhängigen Änderungen (z.B. Interface + Implementierung). ⚠️ Erfordert ALLOW_WRITE=true.",
    schema: S_MassActivate },
  { name: "pretty_print",
    description: "Formatiert ABAP-Quellcode über den SAP Pretty Printer. Einrückung und Schlüsselwort-Schreibweise werden server-seitig konfiguriert (SE38 → Einstellungen). Liefert formatierten Code zurück ohne zu speichern.",
    schema: S_PrettyPrint },

  // ── CREATE ──────────────────────────────────────────────────────────────
  { name: "create_abap_program",
    description: "Legt ein neues ABAP-Programm an. programType='P' für Report (Default), programType='I' für Include. Name muss mit Z oder Y beginnen. ⚠️ Erfordert ALLOW_WRITE=true.",
    schema: S_CreateProgram },
  { name: "create_abap_class",
    description: "Legt eine neue ABAP-Klasse an. Name muss mit ZCL_ oder YCL_ beginnen. ⚠️ Erfordert ALLOW_WRITE=true.",
    schema: S_CreateClass },
  { name: "create_abap_interface",
    description: "Legt ein neues ABAP-Interface an. Name muss mit ZIF_ oder YIF_ beginnen. ⚠️ Erfordert ALLOW_WRITE=true.",
    schema: S_CreateInterface },
  { name: "create_function_group",
    description: "Legt eine neue Funktionsgruppe an. Name muss mit Z oder Y beginnen. ⚠️ Erfordert ALLOW_WRITE=true.",
    schema: S_CreateFunctionGroup },
  { name: "create_cds_view",
    description: "Legt eine neue CDS-View (DDLS) an. Name muss mit Z oder Y beginnen. ⚠️ Erfordert ALLOW_WRITE=true.",
    schema: S_CreateCdsView },
  { name: "create_database_table",
    description: "Legt eine neue transparente Datenbanktabelle (TABL) an. Name muss mit Z oder Y beginnen. ⚠️ Erfordert ALLOW_WRITE=true.",
    schema: S_CreateTable },
  { name: "create_message_class",
    description: "Legt eine neue Nachrichtenklasse (MSAG) an. Name muss mit Z oder Y beginnen. ⚠️ Erfordert ALLOW_WRITE=true.",
    schema: S_CreateMessageClass },

  // ── DELETE ──────────────────────────────────────────────────────────────
  { name: "delete_abap_object",
    description: "Löscht ein ABAP-Objekt dauerhaft. ⛔ NICHT RÜCKGÄNGIG MACHBAR. Erfordert ALLOW_DELETE=true und ALLOW_WRITE=true.",
    schema: S_DeleteObject },

  // ── TEST ────────────────────────────────────────────────────────────────
  { name: "run_unit_tests",
    description: "Führt ABAP Unit Tests für eine Klasse oder ein Programm aus. Liefert Test-Ergebnisse mit Pass/Fail-Status und Fehlermeldungen.",
    schema: S_RunTests },
  { name: "create_test_include",
    description: "Erstellt ein Test-Include (CCAU) für eine vorhandene Klasse. Generiert die Grundstruktur für ABAP Unit Tests. ⚠️ Erfordert ALLOW_WRITE=true.",
    schema: S_CreateTestInclude },

  // ── QUALITY ─────────────────────────────────────────────────────────────
  { name: "run_syntax_check",
    description: "Führt einen ABAP-Syntaxcheck durch ohne zu speichern. Gibt Fehler und Warnungen mit Zeilennummern zurück.",
    schema: S_SyntaxCheck },
  { name: "run_atc_check",
    description: "Startet eine ATC-Prüfung (ABAP Test Cockpit) für ein Objekt. Liefert Code-Qualitätsfunde mit Priorität, Kategorie und Beschreibung.",
    schema: S_RunAtc },

  // ── DIAGNOSTICS ─────────────────────────────────────────────────────────
  { name: "get_short_dumps",
    description: "Liest die Liste der neuesten Short Dumps (Runtime Errors) aus dem System. Entspricht Transaktion ST22.",
    schema: S_GetDumps },
  { name: "get_short_dump_detail",
    description: "Liest Details eines spezifischen Short Dumps: Fehlertext, Call Stack, lokale Variablen, Quellcode-Position.",
    schema: S_GetDumpDetail },
  { name: "get_traces",
    description: "Liest die Liste der Performance Traces (SQL-Trace, ABAP-Trace). Entspricht Transaktion SAT.",
    schema: S_GetTraces },
  { name: "get_trace_detail",
    description: "Liest Details eines spezifischen Performance Traces: Laufzeit, Hit-Count, teuerste Statements.",
    schema: S_GetTraceDetail },

  // ── TRANSPORT ───────────────────────────────────────────────────────────
  { name: "get_transport_info",
    description: "Gibt verfügbare Transportaufträge für ein Objekt und sein Paket zurück.",
    schema: S_TransportInfo },
  { name: "get_transport_objects",
    description: "Listet alle Objekte in einem Transportauftrag auf. Zeigt was ein Transport beinhaltet.",
    schema: S_TransportObjects },

  // ── ABAPGIT ─────────────────────────────────────────────────────────────
  { name: "get_abapgit_repos",
    description: "Listet alle abapGit-Repositories auf die im System konfiguriert sind.",
    schema: S_GitRepos },
  { name: "abapgit_pull",
    description: "Führt einen abapGit Pull für ein Repository durch (importiert Code aus Git). ⚠️ Erfordert ALLOW_WRITE=true.",
    schema: S_GitPull },

  // ── QUERY ───────────────────────────────────────────────────────────────
  { name: "run_select_query",
    description: "Führt ein SELECT-Statement direkt gegen SAP-Tabellen aus. Gibt Ergebnis-Rows als JSON zurück. Nur lesende Zugriffe erlaubt.",
    schema: S_Query },

  // ── NEW TOOLS ─────────────────────────────────────────────────────────────
  { name: "find_definition",
    description: "Springt zur Definition eines Tokens (Variable, Methode, Klasse usw.) im Quellcode. Liefert URI, Zeile und Spalte der Definition.",
    schema: S_FindDefinition },
  { name: "get_revisions",
    description: "Liest die Versionshistorie eines ABAP-Objekts. Liefert alle gespeicherten Revisionen mit Datum, Autor und Transportauftrag.",
    schema: S_GetRevisions },
  { name: "create_transport",
    description: "Legt einen neuen Transportauftrag an. Liefert die Transport-Nummer zurück. ⚠️ Erfordert ALLOW_WRITE=true.",
    schema: S_CreateTransport },
  { name: "get_fix_proposals",
    description: "Holt Quick-Fix-Vorschläge für eine bestimmte Position im Quellcode (z.B. fehlende Methode implementieren, Variable deklarieren).",
    schema: S_FixProposals },
  { name: "get_ddic_element",
    description: "Liest detaillierte DDIC-Informationen zu einer Tabelle, View, Datenelement oder Domäne. Liefert Felder, Typen, Annotationen und Assoziationen.",
    schema: S_GetDdicElement },
  { name: "get_inactive_objects",
    description: "Listet alle inaktiven (nicht-aktivierten) Objekte des aktuellen Users auf.",
    schema: S_GetInactiveObjects },
  { name: "get_table_contents",
    description: "Liest Tabelleninhalte direkt aus einer DDIC-Tabelle. Gibt Daten als JSON zurück.",
    schema: S_GetTableContents },

  // ── CONTEXT ANALYSIS ──────────────────────────────────────────────────
  { name: "analyze_abap_context",
    description: "Analysiert den vollständigen Kontext eines ABAP-Objekts: Liest Quellcode inkl. aller Includes, erkennt referenzierte Funktionsbausteine, Klassen und Interfaces per Regex, ruft deren Metadaten ab und liefert einen strukturierten Kontext-Report. Einstiegspunkt für den abap_develop Workflow.",
    schema: S_AnalyzeContext },

  // ── DOCUMENTATION ─────────────────────────────────────────────────────
  { name: "get_abap_keyword_doc",
    description: "Ruft ABAP-Keyword-Dokumentation von help.sap.com ab (z.B. SELECT, LOOP, READ TABLE). Liefert die offizielle SAP-Doku als formatierten Text.",
    schema: S_GetAbapKeywordDoc },
  { name: "get_abap_class_doc",
    description: "Ruft ABAP-Klassen/Interface-Dokumentation von help.sap.com ab (z.B. CL_SALV_TABLE, IF_AMDP_MARKER_HDB). Liefert die offizielle SAP-Doku als formatierten Text.",
    schema: S_GetAbapClassDoc },
  { name: "get_module_best_practices",
    description: "Liefert modulspezifische SAP ABAP Best Practices (wichtige Tabellen, empfohlene BAPIs/Klassen, Coding-Richtlinien, häufige Fehler, S/4HANA-Migrationshinweise). Module: FI, CO, MM, SD, PP, PM, QM, HR, HCM, PS, WM, EWM, BASIS, BC, ABAP.",
    schema: S_GetModuleBestPractices },
];

// ============================================================================
// TOOL-FINDER META-TOOL (Dynamic Tool Registration)
// ============================================================================

const TOOL_CATEGORIES: Record<string, string[]> = {
  SEARCH:      ["search_abap_objects"],
  READ:        ["read_abap_source", "get_object_info", "where_used", "get_code_completion",
                "find_definition", "get_revisions", "get_ddic_element", "get_table_contents",
                "get_fix_proposals", "analyze_abap_context"],
  WRITE:       ["write_abap_source", "activate_abap_object", "mass_activate", "pretty_print"],
  CREATE:      ["create_abap_program", "create_abap_class", "create_abap_interface",
                "create_function_group", "create_cds_view", "create_database_table",
                "create_message_class"],
  DELETE:      ["delete_abap_object"],
  TEST:        ["run_unit_tests", "create_test_include"],
  QUALITY:     ["run_syntax_check", "run_atc_check"],
  DIAGNOSTICS: ["get_short_dumps", "get_short_dump_detail", "get_traces", "get_trace_detail"],
  TRANSPORT:   ["get_transport_info", "get_transport_objects", "create_transport"],
  ABAPGIT:     ["get_abapgit_repos", "abapgit_pull"],
  QUERY:       ["run_select_query", "get_inactive_objects"],
  DOCUMENTATION: ["get_abap_keyword_doc", "get_abap_class_doc", "get_module_best_practices"],
};

const CORE_TOOL_NAMES = new Set([
  "find_tools",
  "search_abap_objects",
  "read_abap_source",
  "write_abap_source",
  "get_object_info",
  "where_used",
  "analyze_abap_context",
]);

const enabledTools = new Set<string>();

const S_FindTools = z.object({
  query: z.string().optional().describe("Suchmuster fuer Tool-Namen/Beschreibungen"),
  category: z.string().optional().describe(
    "Kategorie: SEARCH | READ | WRITE | CREATE | DELETE | TEST | QUALITY | DIAGNOSTICS | TRANSPORT | ABAPGIT | QUERY | DOCUMENTATION"
  ),
  enable: z.boolean().optional().default(true).describe("Tools aktivieren (default: true)"),
});

const FIND_TOOLS_ENTRY = {
  name: "find_tools",
  description: "Findet und aktiviert ABAP-Tools nach Suchbegriff oder Kategorie. " +
    "Kategorien: SEARCH, READ, WRITE, CREATE, DELETE, TEST, QUALITY, DIAGNOSTICS, TRANSPORT, ABAPGIT, QUERY, DOCUMENTATION. " +
    "Aktivierte Tools werden sofort verfuegbar.",
  schema: S_FindTools,
};

// Build combined tool list (TOOLS + find_tools)
const ALL_TOOLS = [...TOOLS, FIND_TOOLS_ENTRY];

// ============================================================================
// MCP SERVER
// ============================================================================

const server = new Server(
  { name: "abap-mcp-server", version: "2.0.0" },
  { capabilities: { tools: { listChanged: true }, prompts: {} } }
);

// ── LIST TOOLS ──────────────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const visibleTools = cfg.deferTools
    ? ALL_TOOLS.filter(t => CORE_TOOL_NAMES.has(t.name) || enabledTools.has(t.name))
    : ALL_TOOLS;
  return {
    tools: visibleTools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: toJsonSchema(t.schema),
    })),
  };
});

// ── LIST PROMPTS ────────────────────────────────────────────────────────────
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [{
    name: "abap_develop",
    description: "Intelligenter ABAP-Entwicklungsworkflow: Analysiert zuerst den vollständigen Kontext, wendet moderne ABAP-Prinzipien an.",
    arguments: [
      { name: "object_name", description: "Name des ABAP-Objekts (z.B. ZRYBAK_TEST)", required: true },
      { name: "task", description: "Aufgabe (z.B. 'ALV-Grid mit CL_SALV_TABLE einbauen')", required: true },
    ],
  }],
}));

// ── GET PROMPT ──────────────────────────────────────────────────────────────
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: promptArgs } = request.params;
  if (name !== "abap_develop")
    throw new McpError(ErrorCode.InvalidRequest, `Unbekannter Prompt: ${name}`);

  const objectName = promptArgs?.object_name ?? "";
  const task = promptArgs?.task ?? "";

  return {
    messages: [{
      role: "user",
      content: {
        type: "text",
        text:
`Du bist ein erfahrener SAP ABAP-Entwickler. Deine Aufgabe: "${task}" am Objekt "${objectName}".

## PFLICHT-WORKFLOW (Reihenfolge einhalten!)

### Schritt 1: Vollständigen Kontext erfassen
1. Führe \`search_abap_objects(query="${objectName}")\` aus, um die ADT-URL zu ermitteln.
2. Führe \`analyze_abap_context(objectUrl=<url>, depth="deep")\` aus.
3. Lies den Kontext-Report VOLLSTÄNDIG bevor du mit Schritt 2 weitermachst.
   ⚠️ NIEMALS Code schreiben ohne vorher ALLE Includes und referenzierten Objekte gelesen zu haben!

### Schritt 2: Referenzen & Alternativen recherchieren
- Für jeden im Kontext gefundenen Funktionsbaustein: Prüfe ob es modernere Alternativen gibt.
  Beispiele veralteter Patterns → moderne Alternativen:
    • REUSE_ALV_GRID_DISPLAY → CL_SALV_TABLE / CL_GUI_ALV_GRID
    • POPUP_TO_CONFIRM → IF_FPM_POPUP (bei FPM) oder eigene Klasse
    • READ TABLE ... SY-SUBRC → Inline-Deklaration: READ TABLE ... INTO DATA(ls_row)
    • CALL FUNCTION (ohne Ausnahmen) → TRY/CATCH mit CX_* Klassen
    • WRITE / FORMAT → CL_SALV_TABLE oder Web Dynpro / Fiori
- Nutze \`search_abap_objects\` und \`where_used\` um Alternativen im System zu finden.
- Bei Unsicherheit: Suche in der SAP-Dokumentation (Web-Suche) nach Best Practices.

### Schritt 3: Moderne ABAP-Prinzipien anwenden (Clean ABAP)
Beim Coding folgende Prinzipien beachten:
- **Inline-Deklarationen**: DATA(lv_var), FIELD-SYMBOL(<fs>), NEW #(), VALUE #()
- **String Templates**: |Text { lv_var } mehr Text| statt CONCATENATE
- **Funktionale Methoden**: COND #(), SWITCH #(), REDUCE #(), FILTER #()
- **ABAP SQL**: SELECT ... INTO TABLE @DATA(lt_result) (Host-Variablen mit @)
- **Ausnahmen**: CX_*-Klassen und TRY/CATCH statt SY-SUBRC-Prüfung
- **OOP**: Klassen/Interfaces statt Funktionsbausteine für neue Logik
- **Naming**: Clean ABAP Konventionen (keine ungarische Notation für neue Objekte,
  aber bestehende Konventionen im Programm respektieren)
- **Vermeidung**: MOVE, COMPUTE, obsolete Anweisungen (CHECK in Methoden → RETURN)
- **Test-Freundlichkeit**: Abhängigkeiten über Interfaces injizieren

### Schritt 4: Code-Platzierung bestimmen
- Prüfe den Kontext-Report: In welchem Include/Klasse gehört der neue Code hin?
- Bei Reports mit Includes: NIEMALS Code ins Hauptprogramm, wenn es ein passendes Include gibt!
- Bei Klassen: Richtige Methode / richtiges Include wählen
- Bei FuGr: Richtigen Funktionsbaustein identifizieren

### Schritt 5: Implementierung
- Schreibe den Code mit \`write_abap_source\`
- Bei Syntax-/Aktivierungsfehlern: Analysiere, korrigiere, und versuche erneut
- Führe nach der Implementierung \`run_syntax_check\` und ggf. \`run_unit_tests\` aus

### Schritt 6: Qualitätsprüfung
- Führe \`run_atc_check\` aus um Code-Qualität sicherzustellen
- Behebe gefundene Findings (Priorität 1 und 2)`,
      },
    }],
  };
});

// ── CALL TOOL ───────────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const client = await getClient();

  function ok(text: string) { return { content: [{ type: "text" as const, text }] }; }
  function err(text: string) { return { content: [{ type: "text" as const, text }], isError: true }; }

  try {
    switch (name) {

      // ── search_abap_objects ─────────────────────────────────────────────
      case "search_abap_objects": {
        const p = S_Search.parse(args);
        const res = await client.searchObject(p.query, p.objectType, p.maxResults ?? 20);
        const items = (Array.isArray(res) ? res : [res]).map((r) => ({
          name:        r["adtcore:name"],
          type:        r["adtcore:type"],
          uri:         r["adtcore:uri"],
          package:     r["adtcore:packageName"],
          description: r["adtcore:description"],
        }));
        return ok(items.length === 0
          ? `Keine Objekte gefunden für '${p.query}'`
          : `${items.length} Objekte gefunden:\n\n${JSON.stringify(items, null, 2)}`);
      }

      // ── read_abap_source ────────────────────────────────────────────────
      case "read_abap_source": {
        const p = S_ReadSource.parse(args);
        const baseUrl = p.objectUrl.replace(/\/source\/main$/, "");
        const mainUrl = `${baseUrl}/source/main`;
        const mainSrc = await client.getObjectSource(mainUrl);
        const mainText = typeof mainSrc === "string" ? mainSrc : JSON.stringify(mainSrc);

        if (!p.includeRelated) {
          return ok(mainText);
        }

        // ── includeRelated: alle zugehörigen Quellen sammeln ──
        const sections: string[] = [`══ MAIN SOURCE (${baseUrl}) ══\n${mainText}`];

        try {
          const structure = await client.objectStructure(baseUrl);
          const links = (structure as any)?.links ?? (structure as any)?.objectStructure?.links ?? [];
          const metaLinks = (structure as any)?.metaLinks ?? [];

          // Klassen / Interfaces: Includes (Definitionen, Implementierungen, Macros, Testklassen)
          const includes: Array<{ type: string; uri: string }> = [];
          const incArray = (structure as any)?.includes ??
            (structure as any)?.objectStructure?.includes ?? [];
          for (const inc of incArray) {
            const uri = inc?.["abapsource:sourceUri"] ?? inc?.sourceUri ?? inc?.uri ?? "";
            const incType = inc?.["class:includeType"] ?? inc?.includeType ?? inc?.type ?? "unknown";
            if (uri && !uri.endsWith("/source/main")) {
              includes.push({ type: incType, uri });
            }
          }

          // Auch aus Links sourceUri-Einträge extrahieren (für Programme/FuGr)
          for (const link of [...links, ...metaLinks]) {
            const rel = link?.rel ?? "";
            const href = link?.href ?? "";
            if (href && href.includes("/source/") && !href.endsWith("/source/main")) {
              includes.push({ type: rel || "related", uri: href });
            }
          }

          // Alle Include-Quellen parallel lesen
          const includeResults = await Promise.allSettled(
            includes.map(async (inc) => {
              const src = await client.getObjectSource(inc.uri);
              return { type: inc.type, uri: inc.uri, source: typeof src === "string" ? src : JSON.stringify(src) };
            })
          );
          for (const result of includeResults) {
            if (result.status === "fulfilled") {
              const r = result.value;
              sections.push(`══ ${r.type.toUpperCase()} (${r.uri}) ══\n${r.source}`);
            }
          }

          // Programme: INCLUDE-Anweisungen im Quellcode auflösen
          if (baseUrl.includes("/programs/programs/")) {
            const includePattern = /^\s*INCLUDE\s+(\S+?)[\s.]*$/gim;
            let match;
            const resolvedIncludes: string[] = [];
            while ((match = includePattern.exec(mainText)) !== null) {
              const inclName = match[1].toLowerCase().replace(/\.$/, "");
              if (!resolvedIncludes.includes(inclName)) {
                resolvedIncludes.push(inclName);
              }
            }
            if (resolvedIncludes.length > 0) {
              const inclResults = await Promise.allSettled(
                resolvedIncludes.map(async (name) => {
                  const inclUrl = `/sap/bc/adt/programs/includes/${name}/source/main`;
                  const src = await client.getObjectSource(inclUrl);
                  return { name, source: typeof src === "string" ? src : JSON.stringify(src) };
                })
              );
              for (const result of inclResults) {
                if (result.status === "fulfilled") {
                  const r = result.value;
                  sections.push(`══ INCLUDE ${r.name.toUpperCase()} ══\n${r.source}`);
                }
              }
            }
          }

          // Funktionsgruppen: Funktionsbausteine aus Struktur lesen
          if (baseUrl.includes("/functions/groups/")) {
            const fmNodes = (structure as any)?.objectStructure?.nodes ??
              (structure as any)?.nodes ?? [];
            const fmUrls: Array<{ name: string; uri: string }> = [];
            const collectFMs = (nodes: any[]) => {
              for (const node of nodes) {
                const uri = node?.["adtcore:uri"] ?? node?.uri ?? "";
                const name = node?.["adtcore:name"] ?? node?.name ?? "";
                const type = node?.["adtcore:type"] ?? node?.type ?? "";
                if (uri && (type.startsWith("FUGR/FF") || uri.includes("/fmodule/"))) {
                  fmUrls.push({ name, uri });
                }
                if (node?.nodes) collectFMs(node.nodes);
                if (node?.children) collectFMs(node.children);
              }
            };
            collectFMs(Array.isArray(fmNodes) ? fmNodes : []);
            if (fmUrls.length > 0) {
              const fmResults = await Promise.allSettled(
                fmUrls.map(async (fm) => {
                  const src = await client.getObjectSource(`${fm.uri}/source/main`);
                  return { name: fm.name, source: typeof src === "string" ? src : JSON.stringify(src) };
                })
              );
              for (const result of fmResults) {
                if (result.status === "fulfilled") {
                  const r = result.value;
                  sections.push(`══ FUNCTION MODULE ${r.name.toUpperCase()} ══\n${r.source}`);
                }
              }
            }
          }
        } catch (e: any) {
          sections.push(`\n⚠️ Hinweis: Einige zugehörige Objekte konnten nicht gelesen werden: ${e?.message ?? e}`);
        }

        return ok(sections.join("\n\n"));
      }

      // ── get_object_info ─────────────────────────────────────────────────
      case "get_object_info": {
        const p = S_ObjectInfo.parse(args);
        const info = await client.objectStructure(p.objectUrl);
        return ok(JSON.stringify(info, null, 2));
      }

      // ── where_used ──────────────────────────────────────────────────────
      case "where_used": {
        const p = S_WhereUsed.parse(args);
        // Use statelessClone to avoid interfering with concurrent stateful sessions
        const res = await client.statelessClone.usageReferences(p.objectUrl);
        const items = (Array.isArray(res) ? res : []).slice(0, p.maxResults ?? 50);
        return ok(items.length === 0
          ? "Keine Verwendungen gefunden."
          : `${items.length} Verwendungen:\n\n${JSON.stringify(items, null, 2)}`);
      }

      // ── get_code_completion ─────────────────────────────────────────────
      case "get_code_completion": {
        const p = S_CodeCompletion.parse(args);
        const res = await client.codeCompletion(
          p.objectUrl, p.source, p.line, p.column
        );
        const items = Array.isArray(res) ? res : [];
        return ok(items.length === 0
          ? "Keine Vorschläge gefunden."
          : `${items.length} Vorschläge:\n\n${JSON.stringify(items, null, 2)}`);
      }

      // ── write_abap_source ───────────────────────────────────────────────
      case "write_abap_source": {
        assertWriteEnabled();
        const p = S_WriteSource.parse(args);
        const r = await writeWorkflow(
          client, p.objectUrl, p.source,
          p.transport ?? cfg.defaultTransport,
          p.activateAfterWrite ?? true,
          p.skipSyntaxCheck ?? false,
          p.mainProgram,
        );
        const body = r.log.join("\n") + (r.syntaxErrors ? "\n\nSyntaxfehler:\n" + r.syntaxErrors.join("\n") : "");
        if (r.success) {
          return ok(`✅ Erfolgreich geschrieben und aktiviert\n\n${body}`);
        }
        return err(`❌ Fehler — Code NICHT aktiviert!\n\n${body}\n\n⚠️ AKTION ERFORDERLICH: Analysiere die obigen Fehler, korrigiere den ABAP-Quellcode und rufe write_abap_source erneut auf. Wiederhole bis die Aktivierung erfolgreich ist.`);
      }

      // ── activate_abap_object ────────────────────────────────────────────
      case "activate_abap_object": {
        assertWriteEnabled();
        const p = S_Activate.parse(args);
        const activationResult = await client.activate(p.objectName, p.objectUrl);
        if (!activationResult.success) {
          const msgs = formatActivationMessages(activationResult.messages);
          return err(`❌ Aktivierung von '${p.objectName}' fehlgeschlagen\n${msgs.join("\n")}`);
        }
        const extra = activationResult.messages.length > 0
          ? `\n${formatActivationMessages(activationResult.messages).join("\n")}` : "";
        return ok(`✅ '${p.objectName}' erfolgreich aktiviert${extra}`);
      }

      // ── mass_activate ───────────────────────────────────────────────────
      case "mass_activate": {
        assertWriteEnabled();
        const p = S_MassActivate.parse(args);
        if (p.objects.length > 50)
          throw new McpError(ErrorCode.InvalidRequest, "Maximal 50 Objekte pro Mass-Activation.");
        // Activate each object individually to avoid batch-format issues
        const allMessages: ActivationResultMessage[] = [];
        let allSuccess = true;
        for (const obj of p.objects) {
          const activationResult = await client.activate(obj.objectName, obj.objectUrl);
          allMessages.push(...activationResult.messages);
          if (!activationResult.success) allSuccess = false;
        }
        const activationResult = { success: allSuccess, messages: allMessages };
        const msgs = formatActivationMessages(activationResult.messages);
        if (!activationResult.success) {
          return err(`❌ Mass Activation fehlgeschlagen (${p.objects.length} Objekte)\n${msgs.join("\n")}`);
        }
        const extra = msgs.length > 0 ? `\n\nHinweise:\n${msgs.join("\n")}` : "";
        return ok(`✅ Mass Activation: ${p.objects.length} Objekte erfolgreich aktiviert${extra}`);
      }

      // ── pretty_print ────────────────────────────────────────────────────
      case "pretty_print": {
        const p = S_PrettyPrint.parse(args);
        const formatted = await client.prettyPrinter(p.source);
        return ok(typeof formatted === "string" ? formatted : JSON.stringify(formatted));
      }

      // ── create_abap_program ─────────────────────────────────────────────
      case "create_abap_program": {
        assertWriteEnabled();
        const p = S_CreateProgram.parse(args);
        assertPackageAllowed(p.devClass);
        assertCustomerNamespace(p.name, ["Z", "Y"]);
        const n = p.name.toUpperCase();
        const progType = p.programType ?? "P";
        await client.createObject(`PROG/${progType}`, n, p.devClass, p.description, `/sap/bc/adt/packages/${encodeURIComponent(p.devClass)}`, undefined, p.transport || undefined);
        const url = `/sap/bc/adt/programs/programs/${n.toLowerCase()}`;
        const label = progType === "I" ? "Include" : "Programm";
        return ok(`✅ ${label} '${n}' angelegt\nURI: ${url}\n\nNächste Schritte:\n  write_abap_source mit objectUrl='${url}'`);
      }

      // ── create_abap_class ───────────────────────────────────────────────
      case "create_abap_class": {
        assertWriteEnabled();
        const p = S_CreateClass.parse(args);
        assertPackageAllowed(p.devClass);
        assertCustomerNamespace(p.name, ["ZCL_", "YCL_"]);
        const n = p.name.toUpperCase();
        await client.createObject("CLAS/OC", n, p.devClass, p.description, `/sap/bc/adt/packages/${encodeURIComponent(p.devClass)}`, undefined, p.transport || undefined);
        const url = `/sap/bc/adt/oo/classes/${n.toLowerCase()}`;
        return ok(`✅ Klasse '${n}' angelegt\nURI: ${url}\n\nNächste Schritte:\n  read_abap_source → write_abap_source`);
      }

      // ── create_abap_interface ───────────────────────────────────────────
      case "create_abap_interface": {
        assertWriteEnabled();
        const p = S_CreateInterface.parse(args);
        assertPackageAllowed(p.devClass);
        assertCustomerNamespace(p.name, ["ZIF_", "YIF_"]);
        const n = p.name.toUpperCase();
        await client.createObject("INTF/OI", n, p.devClass, p.description, `/sap/bc/adt/packages/${encodeURIComponent(p.devClass)}`, undefined, p.transport || undefined);
        const url = `/sap/bc/adt/oo/interfaces/${n.toLowerCase()}`;
        return ok(`✅ Interface '${n}' angelegt\nURI: ${url}`);
      }

      // ── create_function_group ───────────────────────────────────────────
      case "create_function_group": {
        assertWriteEnabled();
        const p = S_CreateFunctionGroup.parse(args);
        assertPackageAllowed(p.devClass);
        assertCustomerNamespace(p.name, ["Z", "Y"]);
        const n = p.name.toUpperCase();
        await client.createObject("FUGR/F", n, p.devClass, p.description, `/sap/bc/adt/packages/${encodeURIComponent(p.devClass)}`, undefined, p.transport || undefined);
        const url = `/sap/bc/adt/function/groups/${n.toLowerCase()}`;
        return ok(`✅ Funktionsgruppe '${n}' angelegt\nURI: ${url}`);
      }

      // ── create_cds_view ─────────────────────────────────────────────────
      case "create_cds_view": {
        assertWriteEnabled();
        const p = S_CreateCdsView.parse(args);
        assertPackageAllowed(p.devClass);
        assertCustomerNamespace(p.name, ["Z", "Y"]);
        const n = p.name.toUpperCase();
        await client.createObject("DDLS/DF", n, p.devClass, p.description, `/sap/bc/adt/packages/${encodeURIComponent(p.devClass)}`, undefined, p.transport || undefined);
        const url = `/sap/bc/adt/ddic/ddl/sources/${n.toLowerCase()}`;
        return ok(`✅ CDS View '${n}' angelegt\nURI: ${url}`);
      }

      // ── create_database_table ───────────────────────────────────────────
      case "create_database_table": {
        assertWriteEnabled();
        const p = S_CreateTable.parse(args);
        assertPackageAllowed(p.devClass);
        assertCustomerNamespace(p.name, ["Z", "Y"]);
        const n = p.name.toUpperCase();
        await client.createObject("TABL/DT", n, p.devClass, p.description, `/sap/bc/adt/packages/${encodeURIComponent(p.devClass)}`, undefined, p.transport || undefined);
        const url = `/sap/bc/adt/ddic/tables/${n.toLowerCase()}`;
        return ok(`✅ Tabelle '${n}' angelegt\nURI: ${url}`);
      }

      // ── create_message_class ────────────────────────────────────────────
      case "create_message_class": {
        assertWriteEnabled();
        const p = S_CreateMessageClass.parse(args);
        assertPackageAllowed(p.devClass);
        assertCustomerNamespace(p.name, ["Z", "Y"]);
        const n = p.name.toUpperCase();
        await client.createObject("MSAG/N", n, p.devClass, p.description, `/sap/bc/adt/packages/${encodeURIComponent(p.devClass)}`, undefined, p.transport || undefined);
        return ok(`✅ Nachrichtenklasse '${n}' angelegt`);
      }

      // ── delete_abap_object ──────────────────────────────────────────────
      case "delete_abap_object": {
        assertWriteEnabled("Löschen");
        assertDeleteEnabled();
        const p = S_DeleteObject.parse(args);
        await withWriteLock(() => withStatefulSession(client, async () => {
          const lock = await lockWithRetry(client, p.objectUrl);
          try {
            await client.deleteObject(p.objectUrl, lock.LOCK_HANDLE, p.transport || undefined);
          } catch (e) {
            try { await client.unLock(p.objectUrl, lock.LOCK_HANDLE); } catch { /* ignore */ }
            throw e;
          }
        }));
        return ok(`✅ Objekt '${p.objectName}' gelöscht.\n⚠️  Diese Aktion ist nicht rückgängig machbar.`);
      }

      // ── run_unit_tests ──────────────────────────────────────────────────
      case "run_unit_tests": {
        const p = S_RunTests.parse(args);
        const results = await client.unitTestRun(p.objectUrl);
        if (!results || results.length === 0) return ok("Keine Unit Test Ergebnisse — sind Tests vorhanden?");
        let passed = 0, failed = 0;
        for (const cls of results) {
          for (const method of cls.testmethods ?? []) {
            if (method.alerts && method.alerts.length > 0) failed++;
            else passed++;
          }
        }
        const summary = `Unit Tests: ${passed} bestanden, ${failed} fehlgeschlagen`;
        return (failed === 0 ? ok : err)(`${failed === 0 ? "✅" : "❌"} ${summary}\n\n${JSON.stringify(results, null, 2)}`);
      }

      // ── create_test_include ─────────────────────────────────────────────
      case "create_test_include": {
        assertWriteEnabled();
        const p = S_CreateTestInclude.parse(args);
        await withWriteLock(() => withStatefulSession(client, async () => {
          const lock = await lockWithRetry(client, p.classUrl);
          try {
            await client.createTestInclude(p.classUrl, lock.LOCK_HANDLE);
            await client.unLock(p.classUrl, lock.LOCK_HANDLE);
          } catch (e) {
            try { await client.unLock(p.classUrl, lock.LOCK_HANDLE); } catch { /* ignore */ }
            throw e;
          }
        }));
        return ok(`✅ Test-Include erstellt für ${p.classUrl}`);
      }

      // ── run_syntax_check ────────────────────────────────────────────────
      case "run_syntax_check": {
        const p = S_SyntaxCheck.parse(args);
        const res = await client.syntaxCheck(p.objectUrl, resolveMainProgram(p.mainProgram) ?? p.objectUrl, p.source);
        const msgs     = Array.isArray(res) ? res : [];
        const errors   = msgs.filter((m: { severity: string }) => ["E", "A"].includes(m.severity));
        const warnings = msgs.filter((m: { severity: string }) => m.severity === "W");
        const summary  = errors.length === 0
          ? `✅ Syntax OK${warnings.length > 0 ? ` (${warnings.length} Warnungen)` : ""}`
          : `❌ ${errors.length} Fehler, ${warnings.length} Warnungen`;
        return (errors.length === 0 ? ok : err)(`${summary}\n\n${JSON.stringify(msgs, null, 2)}`);
      }

      // ── run_atc_check ───────────────────────────────────────────────────
      case "run_atc_check": {
        const p = S_RunAtc.parse(args);
        const variant = p.checkVariant ?? "DEFAULT";
        const runResult = await client.createAtcRun(variant, p.objectUrl);
        const worklist = await client.atcWorklists(runResult.id);
        const findings = worklist.objects ?? [];
        if (findings.length === 0) return ok("Keine ATC-Befunde — Objekt ist sauber.");
        const summary = `ATC: ${findings.length} Objekte mit Befunden`;
        return ok(`${summary}\n\n${JSON.stringify(worklist, null, 2)}`);
      }

      // ── get_short_dumps ─────────────────────────────────────────────────
      case "get_short_dumps": {
        const p = S_GetDumps.parse(args);
        const res = await client.dumps(p.user);
        return ok(JSON.stringify(res, null, 2));
      }

      // ── get_short_dump_detail ───────────────────────────────────────────
      case "get_short_dump_detail": {
        const p = S_GetDumpDetail.parse(args);
        // Try direct ADT endpoint first to avoid loading all dumps
        try {
          const res = await client.httpClient.request(
            `/sap/bc/adt/runtime/dumps/${encodeURIComponent(p.dumpId)}`, { method: "GET" }
          );
          return ok(typeof res.body === "string" ? res.body : JSON.stringify(res.body, null, 2));
        } catch {
          // Fallback: load all dumps and find the one
          const feed = await client.dumps();
          const dump = feed.dumps?.find(d => d.id === p.dumpId);
          if (!dump) return err(`Dump '${p.dumpId}' nicht gefunden.`);
          return ok(JSON.stringify(dump, null, 2));
        }
      }

      // ── get_traces ──────────────────────────────────────────────────────
      case "get_traces": {
        const p = S_GetTraces.parse(args);
        const res = await client.tracesList(p.user);
        return ok(JSON.stringify(res, null, 2));
      }

      // ── get_trace_detail ────────────────────────────────────────────────
      case "get_trace_detail": {
        const p = S_GetTraceDetail.parse(args);
        const res = await client.tracesHitList(p.traceId, true);
        return ok(JSON.stringify(res, null, 2));
      }

      // ── get_transport_info ──────────────────────────────────────────────
      case "get_transport_info": {
        const p = S_TransportInfo.parse(args);
        const res = await client.transportInfo(p.objectUrl, p.devClass);
        return ok(JSON.stringify(res, null, 2));
      }

      // ── get_transport_objects ───────────────────────────────────────────
      case "get_transport_objects": {
        const p = S_TransportObjects.parse(args);
        // Direct ADT REST call — works for any transport, not just current user's
        const tUrl = `/sap/bc/adt/cts/transportrequests/${encodeURIComponent(p.transportId)}`;
        const tResp = await client.httpClient.request(tUrl, { method: "GET" });
        const xml = typeof tResp.body === "string" ? tResp.body : "";
        // Extract structured object references from ADT XML
        const objects: Array<{ name: string; type: string; uri: string }> = [];
        const objPattern = /<adtcore:objectReference[^>]*adtcore:name="([^"]*)"[^>]*adtcore:type="([^"]*)"[^>]*adtcore:uri="([^"]*)"/g;
        let m;
        while ((m = objPattern.exec(xml)) !== null) {
          objects.push({ name: m[1], type: m[2], uri: m[3] });
        }
        return ok(objects.length > 0
          ? `Transport '${p.transportId}': ${objects.length} Objekte\n\n${JSON.stringify(objects, null, 2)}`
          : `Transport '${p.transportId}':\n\n${xml}`);
      }

      // ── get_abapgit_repos ───────────────────────────────────────────────
      case "get_abapgit_repos": {
        const res = await client.gitRepos();
        const repos = Array.isArray(res) ? res : (res ? [res] : []);
        return ok(repos.length === 0
          ? "Keine abapGit-Repositories konfiguriert."
          : `${repos.length} Repositories:\n\n${JSON.stringify(repos, null, 2)}`);
      }

      // ── abapgit_pull ────────────────────────────────────────────────────
      case "abapgit_pull": {
        assertWriteEnabled("abapGit Pull");
        const p = S_GitPull.parse(args);
        const res = await client.gitPullRepo(p.repoId, undefined, p.transport || undefined);
        return ok(`✅ abapGit Pull ausgeführt\n${JSON.stringify(res, null, 2)}`);
      }

      // ── run_select_query ────────────────────────────────────────────────
      case "run_select_query": {
        const p = S_Query.parse(args);
        assertSelectOnly(p.query);
        const res = await client.runQuery(p.query);
        let warning = "";
        try {
          const sysInfo = await client.httpClient.request("/sap/bc/adt/core/discovery", { method: "GET" });
          const body = typeof sysInfo.body === "string" ? sysInfo.body : "";
          if (/systemType.*?[Pp]roduction/i.test(body) || /role.*?[Pp]roduction/i.test(body)) {
            warning = "⚠️  WARNUNG: Dies scheint ein Produktivsystem zu sein! SELECT-Queries können Performance-Probleme verursachen.\n\n";
          }
        } catch { /* best effort — skip warning if detection fails */ }
        return ok(`${warning}${JSON.stringify(res, null, 2)}`);
      }

      // ── find_definition ──────────────────────────────────────────────────
      case "find_definition": {
        const p = S_FindDefinition.parse(args);
        const res = await client.findDefinition(
          p.objectUrl, p.source, p.line, p.startColumn, p.endColumn,
          false, resolveMainProgram(p.mainProgram)
        );
        return ok(JSON.stringify(res, null, 2));
      }

      // ── get_revisions ────────────────────────────────────────────────────
      case "get_revisions": {
        const p = S_GetRevisions.parse(args);
        const res = await client.revisions(p.objectUrl);
        return ok(res.length === 0
          ? "Keine Revisionen gefunden."
          : `${res.length} Revisionen:\n\n${JSON.stringify(res, null, 2)}`);
      }

      // ── create_transport ─────────────────────────────────────────────────
      case "create_transport": {
        assertWriteEnabled();
        const p = S_CreateTransport.parse(args);
        const transportNumber = await client.createTransport(
          p.objectUrl, p.description, p.devClass, p.transportLayer
        );
        return ok(`✅ Transport '${transportNumber}' angelegt`);
      }

      // ── get_fix_proposals ────────────────────────────────────────────────
      case "get_fix_proposals": {
        const p = S_FixProposals.parse(args);
        const proposals = await client.fixProposals(p.objectUrl, p.source, p.line, p.column);
        if (proposals.length === 0) return ok("Keine Fix-Vorschläge verfügbar.");
        return ok(`${proposals.length} Fix-Vorschläge:\n\n${JSON.stringify(proposals, null, 2)}`);
      }

      // ── get_ddic_element ─────────────────────────────────────────────────
      case "get_ddic_element": {
        const p = S_GetDdicElement.parse(args);
        const res = await client.ddicElement(p.path);
        return ok(JSON.stringify(res, null, 2));
      }

      // ── get_inactive_objects ─────────────────────────────────────────────
      case "get_inactive_objects": {
        const res = await client.inactiveObjects();
        if (res.length === 0) return ok("Keine inaktiven Objekte.");
        return ok(`${res.length} inaktive Objekte:\n\n${JSON.stringify(res, null, 2)}`);
      }

      // ── get_table_contents ───────────────────────────────────────────────
      case "get_table_contents": {
        const p = S_GetTableContents.parse(args);
        const res = await client.tableContents(p.tableName, p.maxRows ?? 100);
        return ok(JSON.stringify(res, null, 2));
      }

      // ── analyze_abap_context ────────────────────────────────────────────
      case "analyze_abap_context": {
        const p = S_AnalyzeContext.parse(args);
        const baseUrl = p.objectUrl.replace(/\/source\/main$/, "");
        const isDeep = (p.depth ?? "deep") === "deep";

        // 1. Read main source + includes (reuse read_abap_source logic with includeRelated)
        const mainUrl = `${baseUrl}/source/main`;
        const mainSrc = await client.getObjectSource(mainUrl);
        const mainText = typeof mainSrc === "string" ? mainSrc : JSON.stringify(mainSrc);

        const sections: string[] = [];
        let includeCount = 0;
        const allSourceTexts: string[] = [mainText];

        // Get object structure
        let structure: any = null;
        let objectType = "Unbekannt";
        let objectPackage = "";
        let objectName = baseUrl.split("/").filter(Boolean).pop() ?? "";

        try {
          structure = await client.objectStructure(baseUrl);
          objectType = (structure as any)?.["adtcore:type"] ?? (structure as any)?.objectStructure?.["adtcore:type"] ?? "Unbekannt";
          objectPackage = (structure as any)?.["adtcore:packageName"] ?? (structure as any)?.objectStructure?.["adtcore:packageName"] ?? "";
          objectName = (structure as any)?.["adtcore:name"] ?? (structure as any)?.objectStructure?.["adtcore:name"] ?? objectName;
        } catch { /* structure read failed — continue with source only */ }

        // Collect includes from structure
        const includesList: Array<{ type: string; uri: string; source?: string }> = [];

        if (structure) {
          const incArray = (structure as any)?.includes ??
            (structure as any)?.objectStructure?.includes ?? [];
          for (const inc of incArray) {
            const uri = inc?.["abapsource:sourceUri"] ?? inc?.sourceUri ?? inc?.uri ?? "";
            const incType = inc?.["class:includeType"] ?? inc?.includeType ?? inc?.type ?? "unknown";
            if (uri && !uri.endsWith("/source/main")) {
              includesList.push({ type: incType, uri });
            }
          }

          const links = (structure as any)?.links ?? (structure as any)?.objectStructure?.links ?? [];
          const metaLinks = (structure as any)?.metaLinks ?? [];
          for (const link of [...links, ...metaLinks]) {
            const href = link?.href ?? "";
            const rel = link?.rel ?? "";
            if (href && href.includes("/source/") && !href.endsWith("/source/main")) {
              includesList.push({ type: rel || "related", uri: href });
            }
          }
        }

        // Read all include sources in parallel
        if (includesList.length > 0) {
          const includeUriToIndex = new Map(includesList.map((inc, i) => [inc.uri, i]));
          const results = await Promise.allSettled(
            includesList.map(async (inc) => {
              const src = await client.getObjectSource(inc.uri);
              return { ...inc, source: typeof src === "string" ? src : JSON.stringify(src) };
            })
          );
          for (const result of results) {
            if (result.status === "fulfilled" && result.value.source) {
              const idx = includeUriToIndex.get(result.value.uri);
              if (idx !== undefined) includesList[idx] = result.value;
              allSourceTexts.push(result.value.source);
              includeCount++;
            }
          }
        }

        // Resolve INCLUDE statements in programs
        if (baseUrl.includes("/programs/programs/")) {
          const includePattern = /^\s*INCLUDE\s+(\S+?)[\s.]*$/gim;
          let match;
          const resolvedIncludes: string[] = [];
          while ((match = includePattern.exec(mainText)) !== null) {
            const inclName = match[1].toLowerCase().replace(/\.$/, "");
            if (!resolvedIncludes.includes(inclName)) resolvedIncludes.push(inclName);
          }
          if (resolvedIncludes.length > 0) {
            const inclResults = await Promise.allSettled(
              resolvedIncludes.map(async (name) => {
                const inclUrl = `/sap/bc/adt/programs/includes/${name}/source/main`;
                const src = await client.getObjectSource(inclUrl);
                return { name, source: typeof src === "string" ? src : JSON.stringify(src) };
              })
            );
            for (const result of inclResults) {
              if (result.status === "fulfilled") {
                allSourceTexts.push(result.value.source);
                includesList.push({ type: "INCLUDE", uri: result.value.name, source: result.value.source });
                includeCount++;
              }
            }
          }
        }

        // FuGr: read function modules
        if (baseUrl.includes("/functions/groups/") && structure) {
          const fmNodes = (structure as any)?.objectStructure?.nodes ?? (structure as any)?.nodes ?? [];
          const fmUrls: Array<{ name: string; uri: string }> = [];
          const collectFMs = (nodes: any[]) => {
            for (const node of nodes) {
              const uri = node?.["adtcore:uri"] ?? node?.uri ?? "";
              const fmName = node?.["adtcore:name"] ?? node?.name ?? "";
              const type = node?.["adtcore:type"] ?? node?.type ?? "";
              if (uri && (type.startsWith("FUGR/FF") || uri.includes("/fmodule/"))) {
                fmUrls.push({ name: fmName, uri });
              }
              if (node?.nodes) collectFMs(node.nodes);
              if (node?.children) collectFMs(node.children);
            }
          };
          collectFMs(Array.isArray(fmNodes) ? fmNodes : []);
          if (fmUrls.length > 0) {
            const fmResults = await Promise.allSettled(
              fmUrls.map(async (fm) => {
                const src = await client.getObjectSource(`${fm.uri}/source/main`);
                return { name: fm.name, source: typeof src === "string" ? src : JSON.stringify(src) };
              })
            );
            for (const result of fmResults) {
              if (result.status === "fulfilled") {
                allSourceTexts.push(result.value.source);
                includesList.push({ type: "FUNCTION MODULE", uri: result.value.name, source: result.value.source });
                includeCount++;
              }
            }
          }
        }

        // 2. Extract class methods/attributes from structure
        const classMethods: string[] = [];
        const classAttributes: string[] = [];
        if (structure) {
          const nodes = (structure as any)?.objectStructure?.nodes ?? (structure as any)?.nodes ?? [];
          const extractMembers = (nodeList: any[]) => {
            for (const node of nodeList) {
              const type = node?.["adtcore:type"] ?? node?.type ?? "";
              const memberName = node?.["adtcore:name"] ?? node?.name ?? "";
              if (type.includes("METHOD") || type.includes("CLAS/OM")) classMethods.push(memberName);
              if (type.includes("ATTR") || type.includes("CLAS/OA")) classAttributes.push(memberName);
              if (node?.nodes) extractMembers(node.nodes);
              if (node?.children) extractMembers(node.children);
            }
          };
          extractMembers(Array.isArray(nodes) ? nodes : []);
        }

        // 3. Regex: find referenced FMs, classes, interfaces in all source texts
        const combinedSource = allSourceTexts.join("\n");
        const referencedFMs = new Set<string>();
        const referencedClasses = new Set<string>();
        const staticCalls = new Set<string>();

        // CALL FUNCTION 'FM_NAME'
        const fmPattern = /CALL\s+FUNCTION\s+'([A-Z0-9_]+)'/gi;
        let fmMatch;
        while ((fmMatch = fmPattern.exec(combinedSource)) !== null) {
          referencedFMs.add(fmMatch[1].toUpperCase());
        }

        // CREATE OBJECT ... TYPE classname / NEW classname(
        const createObjPattern = /CREATE\s+OBJECT\s+\S+\s+TYPE\s+([A-Z0-9_]+)/gi;
        let coMatch;
        while ((coMatch = createObjPattern.exec(combinedSource)) !== null) {
          referencedClasses.add(coMatch[1].toUpperCase());
        }
        const newPattern = /NEW\s+([A-Z][A-Z0-9_]*)\s*\(/gi;
        let newMatch;
        while ((newMatch = newPattern.exec(combinedSource)) !== null) {
          const cls = newMatch[1].toUpperCase();
          if (cls !== "LINE" && cls !== "OBJECT") referencedClasses.add(cls);
        }

        // Static calls: CLASSNAME=>METHOD
        const staticPattern = /([A-Z][A-Z0-9_]*)=>([A-Z0-9_]+)/gi;
        let stMatch;
        while ((stMatch = staticPattern.exec(combinedSource)) !== null) {
          const cls = stMatch[1].toUpperCase();
          const method = stMatch[2].toUpperCase();
          referencedClasses.add(cls);
          staticCalls.add(`${cls}=>${method}`);
        }

        // TYPE REF TO / TYPE classname (for interfaces)
        const typeRefPattern = /TYPE\s+REF\s+TO\s+([A-Z][A-Z0-9_]*)/gi;
        let trMatch;
        while ((trMatch = typeRefPattern.exec(combinedSource)) !== null) {
          referencedClasses.add(trMatch[1].toUpperCase());
        }

        // 4. For deep analysis: get info for referenced FMs and classes
        const fmInfos: Array<{ name: string; info: string }> = [];
        const classInfos: Array<{ name: string; info: string }> = [];

        if (isDeep) {
          // Get FM infos
          const fmInfoResults = await Promise.allSettled(
            Array.from(referencedFMs).map(async (fmName) => {
              try {
                const searchRes = await client.searchObject(fmName, "FUGR/FF", 1);
                const items = Array.isArray(searchRes) ? searchRes : [searchRes];
                if (items.length > 0) {
                  const uri = items[0]["adtcore:uri"];
                  const desc = items[0]["adtcore:description"] ?? "";
                  return { name: fmName, info: `${desc} (${uri})` };
                }
              } catch { /* ignore search failures */ }
              return { name: fmName, info: "(keine Info verfügbar)" };
            })
          );
          for (const r of fmInfoResults) {
            if (r.status === "fulfilled") fmInfos.push(r.value);
          }

          // Get class/interface infos
          const classInfoResults = await Promise.allSettled(
            Array.from(referencedClasses).slice(0, 20).map(async (clsName) => {
              try {
                const searchRes = await client.searchObject(clsName, undefined, 1);
                const items = Array.isArray(searchRes) ? searchRes : [searchRes];
                if (items.length > 0) {
                  const desc = items[0]["adtcore:description"] ?? "";
                  const type = items[0]["adtcore:type"] ?? "";
                  const uri = items[0]["adtcore:uri"] ?? "";
                  let methodList = "";
                  try {
                    const objStruct = await client.objectStructure(uri);
                    const nodes = (objStruct as any)?.objectStructure?.nodes ?? (objStruct as any)?.nodes ?? [];
                    const methods: string[] = [];
                    const extractMethods = (nodeList: any[]) => {
                      for (const node of nodeList) {
                        const nType = node?.["adtcore:type"] ?? node?.type ?? "";
                        const nName = node?.["adtcore:name"] ?? node?.name ?? "";
                        if (nType.includes("METHOD") || nType.includes("CLAS/OM") || nType.includes("INTF/OI")) {
                          methods.push(nName);
                        }
                        if (node?.nodes) extractMethods(node.nodes);
                        if (node?.children) extractMethods(node.children);
                      }
                    };
                    extractMethods(Array.isArray(nodes) ? nodes : []);
                    if (methods.length > 0) methodList = ` | Methoden: ${methods.join(", ")}`;
                  } catch { /* ignore structure read failures */ }
                  return { name: clsName, info: `${type} — ${desc}${methodList}` };
                }
              } catch { /* ignore */ }
              return { name: clsName, info: "(keine Info verfügbar)" };
            })
          );
          for (const r of classInfoResults) {
            if (r.status === "fulfilled") classInfos.push(r.value);
          }
        }

        // 5. Token budget guard for large objects
        const MAX_ANALYZE_CHARS = 150_000;
        const combinedLength = allSourceTexts.reduce((sum, s) => sum + s.length, 0);
        if (combinedLength > MAX_ANALYZE_CHARS) {
          // Truncate allSourceTexts to fit budget, keeping main source intact
          let charBudget = MAX_ANALYZE_CHARS;
          for (let i = 0; i < allSourceTexts.length; i++) {
            if (allSourceTexts[i].length <= charBudget) {
              charBudget -= allSourceTexts[i].length;
            } else {
              allSourceTexts[i] = allSourceTexts[i].slice(0, charBudget) + "\n... (abgeschnitten)";
              allSourceTexts.splice(i + 1);
              break;
            }
          }
          sections.push(`\n⚠️ Quellcode auf ${MAX_ANALYZE_CHARS.toLocaleString()} Zeichen begrenzt (gesamt: ${combinedLength.toLocaleString()}). Nutze read_abap_source für spezifische Includes.`);
        }

        // 6. Build structured report
        sections.push(`══ KONTEXT-ANALYSE: ${objectName.toUpperCase()} ══`);

        // Program structure
        sections.push(`\n📋 PROGRAMMSTRUKTUR`);
        sections.push(`  Typ: ${objectType}`);
        if (objectPackage) sections.push(`  Paket: ${objectPackage}`);
        sections.push(`  Includes: ${includeCount}${includesList.length > 0 ? ` (${includesList.map(i => i.type).join(", ")})` : ""}`);
        if (classMethods.length > 0) sections.push(`  Methoden: ${classMethods.join(", ")}`);
        if (classAttributes.length > 0) sections.push(`  Attribute: ${classAttributes.join(", ")}`);

        // Full source code
        sections.push(`\n📄 QUELLCODE (Main + Includes)`);
        sections.push(`── MAIN (${baseUrl}) ──`);
        sections.push(mainText);
        for (const inc of includesList) {
          if (inc.source) {
            sections.push(`── ${inc.type.toUpperCase()} (${inc.uri}) ──`);
            sections.push(inc.source);
          }
        }

        // Referenced objects
        sections.push(`\n🔗 REFERENZIERTE OBJEKTE`);
        if (referencedFMs.size > 0) {
          sections.push(`  Funktionsbausteine:`);
          for (const fm of referencedFMs) {
            const info = fmInfos.find(f => f.name === fm);
            sections.push(`    - ${fm}${info ? ` (${info.info})` : ""}`);
          }
        }
        if (referencedClasses.size > 0) {
          sections.push(`  Klassen/Interfaces:`);
          for (const cls of referencedClasses) {
            const info = classInfos.find(c => c.name === cls);
            sections.push(`    - ${cls}${info ? ` (${info.info})` : ""}`);
          }
        }
        if (staticCalls.size > 0) {
          sections.push(`  Statische Aufrufe: ${Array.from(staticCalls).join(", ")}`);
        }
        if (referencedFMs.size === 0 && referencedClasses.size === 0) {
          sections.push(`  (keine externen Referenzen erkannt)`);
        }

        // Summary
        sections.push(`\n⚡ ZUSAMMENFASSUNG`);
        sections.push(`  - ${includeCount} Includes, ${referencedFMs.size} FMs, ${referencedClasses.size} Klassen/Interfaces referenziert`);
        if (includesList.length > 0) {
          const mainInclude = includesList.find(i => i.source && i.source.length > mainText.length);
          if (mainInclude) {
            sections.push(`  - Umfangreichster Code in: ${mainInclude.type} (${mainInclude.uri})`);
          }
        }

        return ok(sections.join("\n"));
      }

      // ── get_abap_keyword_doc ────────────────────────────────────────────
      case "get_abap_keyword_doc": {
        const p = S_GetAbapKeywordDoc.parse(args);
        const version = p.version ?? cfg.sapAbapVersion;
        const url = buildKeywordUrl(p.keyword, version);
        let result = await fetchSapDocumentation(url);
        // Fallback: try underscore variant (e.g. "read_table" for "read table")
        if (!result.success) {
          const altUrl = buildKeywordUrl(p.keyword.replace(/[\s]+/g, "_"), version);
          if (altUrl !== url) {
            result = await fetchSapDocumentation(altUrl);
          }
        }
        if (!result.success) {
          return err(`Dokumentation fuer '${p.keyword}' nicht gefunden (${result.content}).\nVersuchte URL: ${result.url}`);
        }
        return ok(`${result.content}\n\n---\nQuelle: ${result.url}`);
      }

      // ── get_abap_class_doc ─────────────────────────────────────────────
      case "get_abap_class_doc": {
        const p = S_GetAbapClassDoc.parse(args);
        const version = p.version ?? cfg.sapAbapVersion;
        const url = buildClassUrl(p.className, version);
        const result = await fetchSapDocumentation(url);
        if (!result.success) {
          return err(`Dokumentation fuer '${p.className}' nicht gefunden (${result.content}).\nVersuchte URL: ${result.url}`);
        }
        return ok(`${result.content}\n\n---\nQuelle: ${result.url}`);
      }

      // ── get_module_best_practices ──────────────────────────────────────
      case "get_module_best_practices": {
        const p = S_GetModuleBestPractices.parse(args);
        const key = p.module.toUpperCase();
        const practices = MODULE_BEST_PRACTICES[key];
        if (!practices) {
          return err(`Keine Best Practices fuer Modul '${p.module}' verfuegbar. Verfuegbare Module: ${Object.keys(MODULE_BEST_PRACTICES).join(", ")}`);
        }
        return ok(practices);
      }

      // ── find_tools ──────────────────────────────────────────────────────
      case "find_tools": {
        const p = S_FindTools.parse(args);
        let matched: typeof TOOLS = [];

        if (p.category) {
          const cat = p.category.toUpperCase();
          const toolNames = TOOL_CATEGORIES[cat];
          if (!toolNames) {
            return err(`Unbekannte Kategorie '${p.category}'. Verfuegbar: ${Object.keys(TOOL_CATEGORIES).join(", ")}`);
          }
          matched = TOOLS.filter(t => toolNames.includes(t.name));
        } else if (p.query) {
          const q = p.query.toLowerCase();
          matched = TOOLS.filter(t =>
            t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
          );
        } else {
          // No parameters: return category overview
          const lines = Object.entries(TOOL_CATEGORIES).map(([cat, names]) =>
            `${cat} (${names.length}): ${names.join(", ")}`
          );
          return ok(
            `Verfuegbare Kategorien:\n\n${lines.join("\n")}\n\n` +
            `Aufruf: find_tools(category="KATEGORIE") oder find_tools(query="suchbegriff")`
          );
        }

        if (matched.length === 0) {
          return ok("Keine passenden Tools gefunden.");
        }

        // Enable/disable tools
        let newlyEnabled = 0;
        for (const t of matched) {
          if (p.enable) {
            if (!enabledTools.has(t.name) && !CORE_TOOL_NAMES.has(t.name)) {
              enabledTools.add(t.name);
              newlyEnabled++;
            }
          } else {
            if (enabledTools.delete(t.name)) newlyEnabled++;
          }
        }

        // Notify client about tool list change
        if (newlyEnabled > 0 && cfg.deferTools) {
          await server.sendToolListChanged();
        }

        const desc = matched.map(t => `• ${t.name}: ${t.description}`).join("\n");
        const action = p.enable ? "aktiviert" : "deaktiviert";
        return ok(
          `${matched.length} Tool(s) gefunden${newlyEnabled > 0 ? `, ${newlyEnabled} ${action}` : ""}:\n\n${desc}`
        );
      }

      default: {
        // Check if the tool exists but is not enabled (deferred)
        const knownTool = ALL_TOOLS.find(t => t.name === name);
        if (knownTool && cfg.deferTools && !CORE_TOOL_NAMES.has(name) && !enabledTools.has(name)) {
          // Find which category this tool belongs to
          const cat = Object.entries(TOOL_CATEGORIES).find(([, names]) => names.includes(name));
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Tool '${name}' ist verfuegbar aber noch nicht aktiviert. ` +
            `Bitte zuerst aufrufen: find_tools(${cat ? `category="${cat[0]}"` : `query="${name}"`})`
          );
        }
        throw new McpError(ErrorCode.MethodNotFound, `Unbekanntes Tool: ${name}`);
      }
    }
  } catch (e) {
    if (e instanceof McpError) throw e;
    if (isAdtError(e)) {
      const parts: string[] = [e.message];
      if (e.properties.conflictText) parts.push(`Konflikt: ${e.properties.conflictText}`);
      if (e.properties.ideUser) parts.push(`Gesperrt von: ${e.properties.ideUser}`);
      const t100id = e.properties["T100KEY-ID"];
      const t100no = e.properties["T100KEY-NO"];
      if (t100id && t100no) parts.push(`T100: ${t100id}/${t100no}`);
      throw new McpError(ErrorCode.InternalError, `ADT Fehler: ${parts.join(" | ")}`);
    }
    const msg = (e instanceof Error ? e.message : String(e))
      .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().substring(0, 600);
    throw new McpError(ErrorCode.InternalError, `ADT Fehler: ${msg}`);
  }
});

// ============================================================================
// STARTUP
// ============================================================================

async function main() {
  const wIcon  = cfg.allowWrite  ? "✅ aktiv" : "❌ deaktiviert";
  const dIcon  = cfg.allowDelete ? "✅ aktiv" : "❌ deaktiviert";
  console.error("╔══════════════════════════════════════════╗");
  console.error("║   ABAP MCP Server v2.0 — Extended        ║");
  console.error("╚══════════════════════════════════════════╝");
  console.error(`  System  : ${cfg.url}`);
  console.error(`  User    : ${cfg.user}  Client: ${cfg.client}  Lang: ${cfg.language}`);
  console.error(`  Write   : ${wIcon}`);
  console.error(`  Delete  : ${dIcon}`);
  if (cfg.allowWrite)
    console.error(`  Blocked : ${cfg.blockedPackages.join(", ") || "keine"}`);
  const tIcon  = cfg.deferTools ? `${CORE_TOOL_NAMES.size} initial (${ALL_TOOLS.length} gesamt, deferred)` : `${ALL_TOOLS.length} registriert`;
  console.error(`  Tools   : ${tIcon}`);
  console.error(`  Doku    : help.sap.com v${cfg.sapAbapVersion}`);
  console.error(`  Prompts : 1 (abap_develop)`);

  try {
    await getClient();
    console.error("  ADT     : ✅ Verbunden");
  } catch (e) {
    console.error(`  ADT     : ⚠️  Verbindung fehlgeschlagen — ${(e as Error).message}`);
    console.error("            Server läuft weiter; Verbindung wird beim ersten Tool-Aufruf erneut versucht.");
    adtClient = null;
  }
  console.error("");

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("✅ MCP Server läuft auf stdio — bereit für Verbindungen");
}

main().catch(e => { console.error("Fataler Fehler:", e); process.exit(1); });
