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
import * as fs from "fs";
import * as path from "path";
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
  allowExecute:            process.env.ALLOW_EXECUTE === "true",
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
      adtClient = null; // Session expired → reconnect
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
      `ADT connection not available: ${e instanceof Error ? e.message : String(e)}. Check: SAP_URL reachable? VPN active? SICF /sap/bc/adt activated? Credentials correct?`);
  }
  return adtClient;
}

// ============================================================================
// CONCURRENCY GUARD — serialize write operations
// ============================================================================

let writeLock: Promise<void> = Promise.resolve();

// Cache für Clean ABAP Styleguide (lazy-loaded, lokale Dateien bevorzugt)
const CLEAN_ABAP_LOCAL_DIR = path.resolve(process.cwd(), "clean-abap");
const CLEAN_ABAP_URL = "https://raw.githubusercontent.com/SAP/styleguides/main/clean-abap/CleanABAP.md";

// Gecachte Abschnitte: Dateiname → Inhalt
let cleanAbapSectionCache: Map<string, string> | null = null;

/** Lädt alle Clean ABAP Markdown-Dateien (lokal bevorzugt, GitHub als Fallback) */
async function loadCleanAbapFiles(): Promise<Map<string, string>> {
  if (cleanAbapSectionCache) return cleanAbapSectionCache;

  const files = new Map<string, string>();

  // Lokale Dateien verwenden wenn vorhanden
  if (fs.existsSync(CLEAN_ABAP_LOCAL_DIR)) {
    const readMd = (filePath: string, label: string) => {
      try {
        files.set(label, fs.readFileSync(filePath, "utf-8"));
      } catch { /* ignorieren */ }
    };

    readMd(path.join(CLEAN_ABAP_LOCAL_DIR, "CleanABAP.md"), "CleanABAP");

    const subDir = path.join(CLEAN_ABAP_LOCAL_DIR, "sub-sections");
    if (fs.existsSync(subDir)) {
      for (const f of fs.readdirSync(subDir)) {
        if (f.endsWith(".md")) {
          readMd(path.join(subDir, f), `sub-sections/${f.replace(".md", "")}`);
        }
      }
    }
  }

  // Fallback: GitHub
  if (files.size === 0) {
    const resp = await fetch(CLEAN_ABAP_URL, {
      signal: AbortSignal.timeout(20_000),
      headers: { "User-Agent": "ABAP-MCP-Server/2.0" },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} loading Clean ABAP Guide`);
    files.set("CleanABAP", await resp.text());
  }

  cleanAbapSectionCache = files;
  return files;
}

/** Zerlegt einen Markdown-Text in Abschnitte anhand von ## Überschriften */
function parseMarkdownSections(md: string): Array<{ heading: string; content: string }> {
  const sections: Array<{ heading: string; content: string }> = [];
  const lines = md.split("\n");
  let currentHeading = "(Intro)";
  let currentLines: string[] = [];

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)/);
    if (h2) {
      if (currentLines.length > 0)
        sections.push({ heading: currentHeading, content: currentLines.join("\n").trim() });
      currentHeading = h2[1].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  if (currentLines.length > 0)
    sections.push({ heading: currentHeading, content: currentLines.join("\n").trim() });
  return sections;
}

/** Sucht im Clean ABAP Guide nach dem relevantesten Abschnitt */
function searchCleanAbapSections(
  sections: Array<{ heading: string; content: string }>,
  query: string,
  maxResults = 3
): Array<{ heading: string; excerpt: string; score: number }> {
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  return sections
    .map(s => {
      const haystack = (s.heading + "\n" + s.content).toLowerCase();
      const score = terms.reduce((acc, t) => acc + (haystack.split(t).length - 1), 0);
      // Abschnitt auf max. ~100 Zeilen kürzen
      const excerpt = s.content.split("\n").slice(0, 100).join("\n").trim();
      return { heading: s.heading, excerpt, score };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

// ============================================================================
// CLEAN ABAP ANTI-PATTERN RULES (static analysis)
// ============================================================================

interface CleanAbapRule {
  id: string;
  pattern: RegExp;
  message: string;
  guidelineQuery: string;
  category: "Names" | "Language" | "Tables" | "Strings" | "Methods" | "ErrorHandling";
  multiline?: boolean;
}

const CLEAN_ABAP_RULES: CleanAbapRule[] = [
  // Names
  { id: "HUNGARIAN_NOTATION",
    pattern: /^\s*DATA\s+[lg][vtso]_\w+/im,
    message: "Hungarian notation prefix (e.g. lv_, lt_, gs_). Clean ABAP avoids type-encoding prefixes.",
    guidelineQuery: "hungarian notation naming prefixes avoid encodings",
    category: "Names" },
  // Language
  { id: "MOVE_STATEMENT",
    pattern: /\bMOVE\s+\S+\s+TO\b/i,
    message: "Obsolete MOVE ... TO. Use = operator instead.",
    guidelineQuery: "MOVE obsolete assignment operator",
    category: "Language" },
  { id: "COMPUTE_STATEMENT",
    pattern: /\bCOMPUTE\b/i,
    message: "Obsolete COMPUTE statement. Use arithmetic expressions directly.",
    guidelineQuery: "COMPUTE obsolete arithmetic",
    category: "Language" },
  { id: "ADD_SUBTRACT",
    pattern: /\b(ADD|SUBTRACT)\s+\S+\s+TO\b/i,
    message: "Obsolete ADD/SUBTRACT. Use += / -= operators.",
    guidelineQuery: "ADD SUBTRACT obsolete arithmetic operators",
    category: "Language" },
  { id: "MULTIPLY_DIVIDE",
    pattern: /\b(MULTIPLY|DIVIDE)\s+\S+\s+BY\b/i,
    message: "Obsolete MULTIPLY/DIVIDE. Use *= / /= operators.",
    guidelineQuery: "MULTIPLY DIVIDE obsolete arithmetic operators",
    category: "Language" },
  { id: "CALL_METHOD",
    pattern: /\bCALL\s+METHOD\b/i,
    message: "Old OO syntax CALL METHOD. Use functional call: object->method( ).",
    guidelineQuery: "CALL METHOD obsolete functional style",
    category: "Language" },
  { id: "FORM_DEFINITION",
    pattern: /^\s*FORM\s+\w+/im,
    message: "FORM subroutine. Use methods in classes instead.",
    guidelineQuery: "FORM subroutine obsolete methods classes",
    category: "Language" },
  // Strings
  { id: "CONCATENATE_STATEMENT",
    pattern: /\bCONCATENATE\b/i,
    message: "CONCATENATE statement. Use string template |{ a }{ b }| instead.",
    guidelineQuery: "CONCATENATE string template pipe operator",
    category: "Strings" },
  // Tables
  { id: "SELECT_ENDSELECT",
    pattern: /\bSELECT\b[\s\S]*?\bENDSELECT\b/i,
    message: "SELECT...ENDSELECT loop. Use SELECT INTO TABLE @DATA(...) for bulk reads.",
    guidelineQuery: "SELECT ENDSELECT loop INTO TABLE modern SQL",
    category: "Tables",
    multiline: true },
  // Methods
  { id: "CHECK_IN_METHOD",
    pattern: /\bMETHOD\b[\s\S]*?\bCHECK\b/,
    message: "CHECK statement inside METHOD body. Use IF ... RETURN instead.",
    guidelineQuery: "CHECK RETURN method early exit",
    category: "Methods",
    multiline: true },
  // Error handling
  { id: "CALL_FUNCTION_SYSUBRC",
    pattern: /CALL\s+FUNCTION\s+['"][^'"]+['"][\s\S]{0,300}?(?:IF\s+sy-subrc|WHEN\s+sy-subrc)/i,
    message: "CALL FUNCTION followed by sy-subrc check. Use EXCEPTIONS + TRY/CATCH with CX_*.",
    guidelineQuery: "sy-subrc CALL FUNCTION exceptions TRY CATCH error handling",
    category: "ErrorHandling",
    multiline: true },
];

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
      console.error("⚠️ dropSession failed:", e instanceof Error ? e.message : String(e));
    }
    client.stateful = session_types.stateless;
  }
}


// ============================================================================
// SAFETY GUARDS
// ============================================================================

function assertWriteEnabled(action = "Write"): void {
  if (!cfg.allowWrite)
    throw new McpError(ErrorCode.InvalidRequest,
      `${action} is disabled. Set ALLOW_WRITE=true in .env. ` +
      "⚠️  Only enable on DEV systems!");
}

function assertDeleteEnabled(): void {
  if (!cfg.allowDelete)
    throw new McpError(ErrorCode.InvalidRequest,
      "Delete is disabled. Set ALLOW_DELETE=true in .env. ⚠️  This action cannot be undone!");
}

function assertPackageAllowed(devClass: string): void {
  const upper = devClass.toUpperCase();
  const blocked = cfg.blockedPackages.find(p => upper.startsWith(p));
  if (blocked)
    throw new McpError(ErrorCode.InvalidRequest,
      `Package '${devClass}' is blocked (prefix '${blocked}' in BLOCKED_PACKAGES).`);
}

function assertCustomerNamespace(name: string, prefix: string[]): void {
  const upper = name.toUpperCase();
  if (!prefix.some(p => upper.startsWith(p)))
    throw new McpError(ErrorCode.InvalidRequest,
      `Name '${name}' must start with ${prefix.join(" or ")} (customer namespace).`);
}

function assertSelectOnly(query: string): void {
  const trimmed = query.trim();
  if (!/^SELECT\s/i.test(trimmed) || /[;.]\s*(INSERT|UPDATE|DELETE|MODIFY|COMMIT)\s/i.test(trimmed))
    throw new McpError(ErrorCode.InvalidRequest,
      "Only SELECT statements are allowed. The query must start with 'SELECT' and must not contain DML statements.");
}

// ============================================================================
// ZOD SCHEMAS — alle Tool-Parameter
// ============================================================================

// --- SEARCH ---
const S_Search = z.object({
  query:       z.string().describe("Name pattern, wildcards * supported, e.g. 'ZCL_*SERVICE*'"),
  maxResults:  z.number().int().min(1).max(100).default(20).optional(),
  objectType:  z.string().optional().describe(
    "ADT type, e.g. PROG/P | CLAS/OC | FUGR/F | INTF/OI | DDLS/DF | TABL/DT | DOMA/DE | DTEL/DE | MSAG/E | SICF/SC. Empty = all types."
  ),
});

// --- READ ---
const S_ReadSource = z.object({
  objectUrl: z.string().describe("ADT URL, e.g. /sap/bc/adt/programs/programs/ztest"),
  includeRelated: z.boolean().default(false).optional().describe(
    "If true, all related objects are automatically read along: " +
    "class includes (definitions, implementations, macros, test classes), " +
    "program includes (INCLUDE statements resolved), function group includes. " +
    "Recommended to understand the full context of an object."
  ),
});
const S_ObjectInfo = z.object({
  objectUrl: z.string().describe("ADT URL of the object"),
});
const S_WhereUsed = z.object({
  objectUrl:  z.string().describe("ADT URL of the object to search"),
  maxResults: z.number().int().min(1).max(200).default(50).optional(),
});
const S_CodeCompletion = z.object({
  objectUrl:   z.string().describe("ADT URL of the object (context for completion)"),
  source:      z.string().describe("Current source code with cursor position"),
  line:        z.number().int().min(1).describe("Cursor line (1-based)"),
  column:      z.number().int().min(0).describe("Cursor column (0-based)"),
});

// --- WRITE ---
const S_WriteSource = z.object({
  objectUrl:          z.string().describe("ADT URL without /source/main suffix"),
  source:             z.string().optional().describe("Complete ABAP source code — use only for short snippets (< 20 lines). For larger programs, write to a temp file and use 'sourcePath' instead."),
  sourcePath:         z.string().optional().describe("PREFERRED: Path to a local file with the ABAP source. Write source to disk first (e.g. /tmp/zmy_prog.abap), then pass this path. Faster, cheaper, and avoids JSON escaping issues."),
  transport:          z.string().optional().describe("Transport request, e.g. DEVK900123"),
  activateAfterWrite: z.boolean().default(true).optional().describe("Activate after writing (default: true)"),
  skipSyntaxCheck:    z.boolean().default(false).optional().describe("Skip syntax check (not recommended)"),
  mainProgram:        z.string().optional().describe("Main program for syntax check of includes — name (e.g. ZRYBAK_AI_TEST) or ADT URL"),
}).refine(d => !!(d.source ?? d.sourcePath), {
  message: "Either 'source' or 'sourcePath' must be provided",
});
const S_Activate = z.object({
  objectUrl:  z.string().describe("ADT URL of the object"),
  objectName: z.string().describe("Object name, e.g. ZTEST or ZCL_FOO"),
});
const S_MassActivate = z.object({
  objects: z.array(z.object({
    objectUrl:  z.string().describe("ADT URL"),
    objectName: z.string().describe("Object name"),
    objectType: z.string().optional().describe("ADT type, e.g. PROG/P, PROG/I, CLAS/OC (optional, derived from URL)"),
  })).describe("List of objects to activate (max. 50)"),
});
const S_PrettyPrint = z.object({
  source:      z.string().describe("ABAP source code to format"),
  objectUrl:   z.string().optional().describe("ADT URL (for context, optional)"),
});

// --- CREATE ---
const S_CreateProgram = z.object({
  name:        z.string().min(1).max(30).describe("Program name, must start with Z or Y"),
  description: z.string().max(40).describe("Short description (max 40 characters)"),
  devClass:    z.string().describe("Package, e.g. ZLOCAL or $TMP"),
  transport:   z.string().optional().describe("Transport request (empty for local objects)"),
  programType: z.enum(["P", "I"]).default("P").optional().describe("P = Executable (Report), I = Include (default: P)"),
});
const S_CreateClass = z.object({
  name:        z.string().min(1).max(30).describe("Class name, must start with ZCL_ or YCL_"),
  description: z.string().max(40).describe("Short description"),
  devClass:    z.string().describe("Package"),
  transport:   z.string().optional(),
  superClass:  z.string().optional().describe("Super class, e.g. CL_ABAP_UNIT_ASSERT"),
});
const S_CreateInterface = z.object({
  name:        z.string().min(1).max(30).describe("Interface name, must start with ZIF_ or YIF_"),
  description: z.string().max(40).describe("Short description"),
  devClass:    z.string().describe("Package"),
  transport:   z.string().optional(),
});
const S_CreateFunctionGroup = z.object({
  name:        z.string().min(1).max(26).describe("Function group name, must start with Z or Y"),
  description: z.string().max(40).describe("Short description"),
  devClass:    z.string().describe("Package"),
  transport:   z.string().optional(),
});
const S_CreateCdsView = z.object({
  name:        z.string().min(1).max(30).describe("CDS name, must start with Z or Y"),
  description: z.string().max(40).describe("Short description"),
  devClass:    z.string().describe("Package"),
  transport:   z.string().optional(),
});
const S_CreateTable = z.object({
  name:        z.string().min(1).max(16).describe("Table name, must start with Z or Y"),
  description: z.string().max(40).describe("Short description"),
  devClass:    z.string().describe("Package"),
  transport:   z.string().optional(),
});
const S_CreateMessageClass = z.object({
  name:        z.string().min(1).max(20).describe("Message class name, must start with Z or Y"),
  description: z.string().max(40).describe("Short description"),
  devClass:    z.string().describe("Package"),
  transport:   z.string().optional(),
});

// --- DELETE ---
const S_DeleteObject = z.object({
  objectUrl:  z.string().describe("ADT URL of the object to delete"),
  objectName: z.string().describe("Object name (for confirmation)"),
  transport:  z.string().optional().describe("Transport request"),
});

// --- TEST ---
const S_RunTests = z.object({
  objectUrl: z.string().describe("ADT URL of the class or program"),
});
const S_CreateTestInclude = z.object({
  classUrl: z.string().describe("ADT URL of the class, e.g. /sap/bc/adt/oo/classes/zcl_foo"),
});

// --- QUALITY ---
const S_SyntaxCheck = z.object({
  objectUrl:   z.string().describe("ADT URL of the object"),
  source:      z.string().describe("ABAP source code"),
  mainProgram: z.string().optional().describe("Main program (for includes) — name or ADT URL"),
});
const S_RunAtc = z.object({
  objectUrl:  z.string().describe("ADT URL of the object to check"),
  checkVariant: z.string().default("DEFAULT").optional().describe("ATC check variant (default: DEFAULT)"),
});
const S_ValidateDdic = z.object({
  source: z.string().describe("ABAP source code to validate program logic for"),
});

// --- DIAGNOSTICS ---
const S_GetDumps = z.object({
  maxResults: z.number().int().min(1).max(100).default(20).optional(),
  user:       z.string().optional().describe("Filter by user"),
  since:      z.string().optional().describe("Time filter ISO-8601, e.g. 2025-01-01T00:00:00Z"),
});
const S_GetDumpDetail = z.object({
  dumpId: z.string().describe("Dump ID from get_short_dumps"),
});
const S_GetTraces = z.object({
  maxResults: z.number().int().min(1).max(50).default(10).optional(),
  user:       z.string().optional().describe("Filter by user"),
});
const S_GetTraceDetail = z.object({
  traceId: z.string().describe("Trace ID from get_traces"),
});

// --- TRANSPORT ---
const S_TransportInfo = z.object({
  objectUrl: z.string().describe("ADT URL of the object"),
  devClass:  z.string().describe("Package of the object"),
});
const S_TransportObjects = z.object({
  transportId: z.string().describe("Transport request, e.g. DEVK900123"),
});

// --- ABAPGIT ---
const S_GitRepos = z.object({
  objectUrl: z.string().optional().describe("System connection URL (empty = active system)"),
});
const S_GitPull = z.object({
  repoId:    z.string().describe("abapGit repository ID"),
  transport: z.string().optional().describe("Transport request for pull"),
});

// --- QUERY ---
const S_Query = z.object({
  query: z.string().describe("SELECT statement, e.g. SELECT * FROM T001 UP TO 10 ROWS"),
});
const S_ExecuteSnippet = z.object({
  source: z.string().describe(
    "Complete executable ABAP code. Must be a valid program — " +
    "starts with REPORT or PROGRAM, ends with a period. " +
    "Output via WRITE statements. No SELECTION-SCREEN."
  ),
  timeout: z.number().int().min(1).max(30).default(10).optional()
    .describe("Maximum runtime in seconds (default: 10, max: 30)"),
});

// --- NEW TOOLS ---
const S_FindDefinition = z.object({
  objectUrl:   z.string().describe("ADT URL of the source object (context)"),
  source:      z.string().describe("Current source code"),
  line:        z.number().int().min(1).describe("Token line (1-based)"),
  startColumn: z.number().int().min(0).describe("Token start column (0-based)"),
  endColumn:   z.number().int().min(0).describe("Token end column (0-based)"),
  mainProgram: z.string().optional().describe("Main program (for includes)"),
});
const S_GetRevisions = z.object({
  objectUrl: z.string().describe("ADT URL of the object"),
});
const S_CreateTransport = z.object({
  objectUrl:      z.string().describe("ADT URL of the object"),
  description:    z.string().max(60).describe("Transport description text"),
  devClass:       z.string().describe("Package"),
  transportLayer: z.string().optional().describe("Transport layer (optional)"),
});
const S_FixProposals = z.object({
  objectUrl:   z.string().describe("ADT URL of the object"),
  source:      z.string().describe("Current source code"),
  line:        z.number().int().min(1).describe("Error line (1-based)"),
  column:      z.number().int().min(0).describe("Error column (0-based)"),
});
const S_GetDdicElement = z.object({
  path: z.string().describe("DDIC path, e.g. table name or CDS view name"),
});
const S_GetInactiveObjects = z.object({});
const S_GetTableContents = z.object({
  tableName: z.string().describe("Name of the DDIC table"),
  maxRows:   z.number().int().min(1).max(1000).default(100).optional().describe("Max. number of rows (default: 100)"),
});

// --- CONTEXT ANALYSIS ---
const S_AnalyzeContext = z.object({
  objectUrl: z.string().describe("ADT URL of the main object"),
  depth: z.enum(["shallow", "deep"]).default("deep").optional()
    .describe("shallow = main source + direct includes only; deep = recursively all references"),
});

// --- DOCUMENTATION ---
const S_GetAbapKeywordDoc = z.object({
  keyword: z.string().describe("ABAP keyword (e.g. SELECT, LOOP, READ TABLE, MODIFY)"),
  version: z.string().optional().describe("ABAP version (e.g. 'latest', '758', '754'). Default: cfg.sapAbapVersion"),
});
const S_GetAbapClassDoc = z.object({
  className: z.string().describe("ABAP class name or interface (e.g. CL_SALV_TABLE, IF_AMDP_MARKER_HDB)"),
  version: z.string().optional().describe("ABAP version (e.g. 'latest', '758', '754'). Default: cfg.sapAbapVersion"),
});
const S_GetModuleBestPractices = z.object({
  module: z.enum(["FI", "CO", "MM", "SD", "PP", "PM", "QM", "HR", "HCM", "PS", "WM", "EWM", "BASIS", "BC", "ABAP"])
    .describe("SAP module (e.g. FI, MM, SD, ABAP)"),
});
const S_SearchCleanAbap = z.object({
  query: z.string().describe(
    "Search query in the SAP Clean ABAP Styleguide (e.g. 'naming conventions', 'error handling', 'SELECT', 'method length', 'comments'). " +
    "Returns the most relevant sections from the official github.com/SAP/styleguides Clean ABAP Guide."
  ),
  maxResults: z.number().int().min(1).max(5).optional()
    .describe("Maximum number of sections (1–5, default: 2)"),
});
const S_ReviewCleanAbap = z.object({
  source: z.string().describe(
    "ABAP source code to review for Clean ABAP compliance. " +
    "Detects anti-patterns (Hungarian notation, obsolete statements, etc.) " +
    "and returns findings with relevant Clean ABAP guideline excerpts."
  ),
  maxFindings: z.number().int().min(1).max(50).optional()
    .describe("Maximum number of findings to report (1–50, default: 10)"),
});
const S_SearchAbapSyntax = z.object({
  query: z.string().describe(
    "Free-text search query for ABAP syntax (e.g. 'SELECT UP TO ROWS', 'LOOP AT clause order', 'READ TABLE WITH KEY'). " +
    "The tool identifies the main keyword, loads the official SAP documentation page and returns the relevant syntax section."
  ),
  version: z.string().optional().describe("ABAP version (e.g. 'latest', '758', '754'). Default: cfg.sapAbapVersion"),
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

async function resolveSyntaxContext(
  client: ADTClient,
  objectUrl: string,
  mainProgram?: string,
  log?: string[],
): Promise<string> {
  const explicitMain = resolveMainProgram(mainProgram);
  if (explicitMain) return explicitMain;

  // Include-Programme brauchen ein Hauptprogramm als Kontext,
  // sonst entstehen häufig "No component exists"-Fehler obwohl der Code korrekt ist.
  if (objectUrl.includes("/programs/includes/")) {
    try {
      const mains = await client.mainPrograms(objectUrl);
      const autoMain = mains[0]?.["adtcore:uri"];
      if (autoMain) {
        log?.push(`📎 Syntax context automatically determined: ${mains[0]["adtcore:name"]}`);
        return autoMain;
      }
    } catch (e) {
      log?.push(`⚠️ Main program for syntax check could not be determined: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return objectUrl;
}

type DdicValidationResult = {
  tableCount: number;
  validCount: number;
  invalid: string[];
  checks: string[];
};

async function validateDdicReferencesInternal(client: ADTClient, source: string): Promise<DdicValidationResult> {
  const tableFieldMap = new Map<string, Set<string>>(); // tableName → Set<fieldName>

  // Strip ABAP comments before processing to avoid false matches:
  // - Full-line comments: lines starting with optional whitespace + *
  // - Inline comments: everything after " on a code line
  const stripComments = (src: string): string =>
    src.split('\n').map(line => {
      if (/^\s*\*/.test(line)) return '';        // full-line comment
      const idx = line.indexOf('"');
      return idx >= 0 ? line.substring(0, idx) : line;
    }).join('\n');

  const cleanSource = stripComments(source);

  const patterns = [
    /\bTYPE\s+([A-Z][A-Z0-9_]{1,30})-([A-Z][A-Z0-9_]{1,30})\b/gi,
    /\bLIKE\s+([A-Z][A-Z0-9_]{1,30})-([A-Z][A-Z0-9_]{1,30})\b/gi,
  ];

  const skipTable = (t: string) =>
    /^[LG][TSVO]_/.test(t) || /^[LG]S_/.test(t) ||
    /^(C|N|I|F|P|X|D|T|STRING|XSTRING|ABAP_.*)$/.test(t);

  const SQL_KW = new Set([
    "SINGLE", "DISTINCT", "COUNT", "SUM", "AVG", "MIN", "MAX", "AS", "CASE", "WHEN",
    "THEN", "ELSE", "END", "UP", "TO", "ROWS", "APPENDING", "CORRESPONDING", "FIELDS",
    "OF", "TABLE", "INTO", "FOR", "ALL", "ENTRIES", "IN", "AND", "OR", "NOT",
    "ORDER", "BY", "GROUP", "HAVING", "INNER", "LEFT", "RIGHT", "OUTER", "JOIN", "ON",
    "CROSS", "UNION", "EXCEPT", "INTERSECT", "EXISTS", "BETWEEN", "LIKE", "IS", "NULL",
    "ASCENDING", "DESCENDING", "CLIENT", "SPECIFIED", "BYPASSING", "BUFFER", "CONNECTION",
    "WHERE", "FROM", "SELECT", "UPDATE", "DELETE", "INSERT", "MODIFY", "DATA", "VALUE",
  ]);

  const addField = (t: string, f: string) => {
    if (skipTable(t) || SQL_KW.has(f)) return;
    if (!tableFieldMap.has(t)) tableFieldMap.set(t, new Set());
    tableFieldMap.get(t)!.add(f);
  };

  for (const pattern of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(cleanSource)) !== null) {
      addField(m[1].toUpperCase(), m[2].toUpperCase());
    }
  }

  const tildePattern = /\b([A-Z][A-Z0-9_]{2,30})~([A-Z][A-Z0-9_]{1,30})\b/gi;
  let tm: RegExpExecArray | null;
  while ((tm = tildePattern.exec(cleanSource)) !== null) {
    addField(tm[1].toUpperCase(), tm[2].toUpperCase());
  }

  const selectPattern = /\bSELECT\s+(?:SINGLE\s+|DISTINCT\s+)?([\s\S]*?)\bFROM\s+([A-Z][A-Z0-9_\/]{2,30})\b([\s\S]*?)\./gi;
  let sm: RegExpExecArray | null;
  while ((sm = selectPattern.exec(cleanSource)) !== null) {
    const [, selectList, tableName, rest] = sm;
    const t = tableName.toUpperCase();
    if (skipTable(t)) continue;

    // Skip SELECT field list for JOIN queries: fields may belong to joined tables,
    // not the main FROM table. Tilde patterns (table~field) handle JOIN fields correctly.
    const hasJoin = /\b(?:INNER|LEFT|RIGHT|OUTER|CROSS)\s+JOIN\b/i.test(rest);
    if (!hasJoin && selectList.trim() !== "*") {
      const tokens = selectList.match(/\b([A-Z_][A-Z0-9_]*)\b/gi) ?? [];
      for (const tok of tokens) {
        const u = tok.toUpperCase();
        if (!SQL_KW.has(u)) addField(t, u);
      }
    }

    const whereMatch = rest.match(/\bWHERE\b([\s\S]*)/i);
    if (whereMatch) {
      // Remove subqueries (inner SELECT ... ) to avoid attributing their WHERE fields
      // to the outer table (e.g. KONV-VBELN from a nested SELECT FROM VBAK).
      const whereClause = whereMatch[1].replace(/\(\s*SELECT\s+[\s\S]*?\)/gi, '');

      // Skip fields that are tilde-qualified (table~field) — already handled above.
      // Also skip fields in JOIN queries to avoid cross-table attribution.
      if (!hasJoin) {
        for (const fm of whereClause.matchAll(/(?<![~\w])([A-Z_][A-Z0-9_]*)\s*(?:=|<>|>=|<=|>|<|\bIN\b|\bLIKE\b|\bBETWEEN\b|\bIS\b)/gi)) {
          const u = fm[1].toUpperCase();
          if (!SQL_KW.has(u)) addField(t, u);
        }
      }
    }
  }

  // Post-processing: remove field entries that are themselves table names
  // (table names accidentally added from SELECT field lists in non-JOIN queries)
  const allTableNames = new Set(tableFieldMap.keys());
  for (const [, fields] of tableFieldMap) {
    for (const field of [...fields]) {
      if (allTableNames.has(field)) fields.delete(field);
    }
  }
  for (const [table, fields] of tableFieldMap) {
    if (fields.size === 0) tableFieldMap.delete(table);
  }

  if (tableFieldMap.size === 0) {
    return { tableCount: 0, validCount: 0, invalid: [], checks: [] };
  }

  const tableNames = [...tableFieldMap.keys()];
  const checks: string[] = [];
  const invalid: string[] = [];
  let validCount = 0;

  await Promise.all(tableNames.map(async (tableName) => {
    try {
      const ddic = await client.ddicElement(tableName);
      const knownFields = new Set((ddic.children ?? []).map((c: { name: string }) => c.name.toUpperCase()));
      const referencedFields = tableFieldMap.get(tableName)!;

      for (const field of referencedFields) {
        if (knownFields.has(field)) {
          validCount++;
        } else {
          invalid.push(`  ❌ ${tableName}-${field}: Field not found (table has ${knownFields.size} fields)`);
        }
      }

      checks.push(`  ✅ ${tableName}: ${referencedFields.size} referenced fields checked`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      checks.push(`  ⚠️  ${tableName}: DDIC not resolvable — ${msg.substring(0, 80)}`);
    }
  }));

  return { tableCount: tableNames.length, validCount, invalid, checks: checks.sort() };
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
    content = content.substring(0, 8000) + "\n\n... (truncated)";
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

## Important Tables & Structures
- BKPF/BSEG — Document header/line items
- BSID/BSAD — Customer open items (open/cleared)
- BSIK/BSAK — Vendor open items (open/cleared)
- SKA1/SKB1 — G/L accounts (chart/company code)
- T001 — Company codes

## Recommended BAPIs & Classes
- BAPI_ACC_DOCUMENT_POST — Post accounting documents (instead of FB01 directly)
- BAPI_ACC_DOCUMENT_REV_POST — Reverse document
- CL_ACC_DOCUMENT — OO API for documents (S/4HANA)
- BAPI_COMPANYCODE_GETLIST — Read company codes

## Coding Guidelines
- NEVER write directly to BKPF/BSEG — always use BAPIs or ACC classes
- Posting logic via BAPI_ACC_DOCUMENT_POST, not BDC on FB01
- Leave tax calculation to the system (CALCULATE_TAX_FROM_NET_AMOUNT)
- Currency conversion: CONVERT_TO_LOCAL_CURRENCY

## Common Errors
- Direct BSEG selects without index → performance problems (BSEG is a cluster table!)
- In S/4HANA: BSEG is a view on ACDOCA → use SELECT on ACDOCA
- Missing BAPI_TRANSACTION_COMMIT after BAPI calls
- Currency fields without reference to currency key

## S/4HANA Migration
- BSEG → ACDOCA (Universal Journal)
- New CDS Views: I_JournalEntry, I_OperationalAcctgDocItem
- FAGL_SPLITTER replaces classic splitting`,

  CO: `# SAP CO (Controlling) — Best Practices

## Important Tables & Structures
- CSKS/CSKT — Cost centers (master/texts)
- CSKA/CSKB — Cost elements
- COBK/COEP — CO document header/line items
- COSS/COSP — Statistical/plan totals
- AUFK — Internal orders

## Recommended BAPIs & Classes
- BAPI_COSTCENTER_GETLIST — Read cost centers
- BAPI_INTERNALORDER_GETLIST — Read orders
- K_ORDER_READ — Read order data
- BAPI_ACC_ACTIVITY_ALLOC_POST — Activity allocation

## Coding Guidelines
- CO postings always via BAPIs, never directly on COEP
- Read cost center hierarchies via SET function modules
- Plan values via BAPI_COSTCENTER_PLAN_POST
- CO-PA: COPA_FUNCTION_MODULE calls for profitability objects

## Common Errors
- Missing authorization on CO objects (controlling area)
- Period-end accruals not considered in reports
- CO-PA characteristics incorrectly assigned

## S/4HANA Migration
- CO documents integrated in ACDOCA
- CDS Views: I_CostCenter, I_InternalOrder
- Embedded Analytics instead of Report Painter/Writer`,

  MM: `# SAP MM (Materials Management) — Best Practices

## Important Tables & Structures
- MARA/MAKT/MARC/MARD — Material master
- EKKO/EKPO — Purchase order header/line items
- EBAN — Purchase requisitions
- MKPF/MSEG — Material documents
- MCHB — Batch stock

## Recommended BAPIs & Classes
- BAPI_PO_CREATE1 — Create purchase order
- BAPI_PR_CREATE — Create purchase requisition
- BAPI_MATERIAL_GET_DETAIL — Read material master
- BAPI_GOODSMVT_CREATE — Post goods movement
- CL_EXITHANDLER — BAdI implementations for MM enhancements

## Coding Guidelines
- Read material master: BAPI_MATERIAL_GET_DETAIL or SELECT on MARA with buffering
- Purchase orders: BAPI_PO_CREATE1 (never ME_CREATE_PO directly)
- Goods movements: BAPI_GOODSMVT_CREATE with GM_CODE
- Reservations: BAPI_RESERVATION_CREATE1

## Common Errors
- SELECT * on MSEG without restriction → huge data volumes
- Missing COMMIT WORK after BAPI calls
- Unit of measure conversion forgotten (UNIT_CONVERSION_SIMPLE)

## S/4HANA Migration
- MARD simplified (no LQUA directly anymore)
- MATDOC replaces MKPF/MSEG for new documents
- CDS Views: I_PurchaseOrderAPI01, I_Material`,

  SD: `# SAP SD (Sales & Distribution) — Best Practices

## Important Tables & Structures
- VBAK/VBAP — Sales order header/line items
- LIKP/LIPS — Delivery header/line items
- VBRK/VBRP — Billing document header/line items
- KNA1/KNVV — Customer master
- KONV — Conditions

## Recommended BAPIs & Classes
- BAPI_SALESORDER_CREATEFROMDAT2 — Create sales order
- BAPI_DELIVERY_GETLIST — Read deliveries
- BAPI_BILLINGDOC_CREATEMULTIPLE — Create billing document
- SD_SALESDOCUMENT_CREATE — newer API

## Coding Guidelines
- Create orders via BAPIs, not BDC on VA01
- Pricing: use pricing BAdIs, do not change KONV directly
- Availability: ATP function modules (AVAILABILITY_CHECK)
- Partner determination: respect standard partner schema

## Common Errors
- VBAP SELECT without order type restriction → performance
- Bypassing condition technique instead of configuring correctly
- Missing authorization checks on sales organization

## S/4HANA Migration
- CDS Views: I_SalesOrder, I_SalesOrderItem, I_BillingDocument
- Credit management via SAP Credit Management (FIN-FSCM-CR)
- Output management via BRF+`,

  PP: `# SAP PP (Production Planning) — Best Practices

## Important Tables & Structures
- AFKO/AFPO — Production order header/line items
- AFVC/AFVV — Operations/operation values
- STKO/STPO — Bills of material
- PLKO/PLPO — Routings
- RESB — Reservations

## Recommended BAPIs & Classes
- BAPI_PRODORD_CREATE — Create production order
- BAPI_PRODORD_RELEASE — Release order
- BAPI_GOODSMVT_CREATE — Confirmation/goods movement
- CS_BOM_EXPL_MAT_V2 — BOM explosion

## Coding Guidelines
- Production orders: use BAPIs, not CO01 BDC
- BOMs: CS_BOM_EXPL_MAT_V2 for explosion
- Capacity planning: use standard function modules
- Confirmations: BAPI_PRODORDCONF_CREATE_TT

## Common Errors
- BOM explosion without key date
- Missing status check before order operations
- Performance with mass BOM explosions

## S/4HANA Migration
- CDS Views: I_ProductionOrder, I_ManufacturingOrder
- PP/DS partially replaces classic planning`,

  PM: `# SAP PM (Plant Maintenance) — Best Practices

## Important Tables & Structures
- EQUI/EQKT — Equipment
- IFLO/IFLOT — Functional locations
- AUFK — PM orders
- AFIH — Maintenance order header
- QMEL — Notifications

## Recommended BAPIs & Classes
- BAPI_EQUI_CREATE — Create equipment
- BAPI_ALM_ORDER_MAINTAIN — Maintain PM order
- BAPI_ALM_NOTIF_CREATE — Create notification
- BAPI_FUNCLOC_CREATE — Create functional location

## Coding Guidelines
- PM orders: BAPI_ALM_ORDER_MAINTAIN (multi-step)
- Notifications: BAPI_ALM_NOTIF_* family
- Classification: BAPI_CLASSIFICATION_*
- Measurement documents: MEASUREM_DOCUM_RFC_SINGLE_001

## Common Errors
- Missing partner maintenance on orders
- Status network not respected
- Equipment hierarchy built incorrectly

## S/4HANA Migration
- Asset Management integration
- CDS Views: I_MaintenanceOrder, I_FunctionalLocation`,

  QM: `# SAP QM (Quality Management) — Best Practices

## Important Tables & Structures
- QALS — Inspection lots
- QASR — Sample results
- QAVE — Usage decisions
- QMEL — Quality notifications
- QMFE — Defects/causes

## Recommended BAPIs & Classes
- BAPI_QUALNOT_CREATE — Create quality notification
- BAPI_INSPLOT_GETLIST — Read inspection lots
- QM_INSPECTION_LOT_CREATE — Create inspection lot

## Coding Guidelines
- Do not manually create inspection lots if automatic lot opening is configured
- Usage decisions: use standard workflow
- Consistently maintain catalogs for defect types

## Common Errors
- Inspection point assignment in routings forgotten
- QM authorizations too restrictive/too open
- Missing dynamic modification rules for sampling

## S/4HANA Migration
- Embedded QM in S/4HANA Manufacturing
- CDS Views: I_InspectionLot, I_QualityNotification`,

  HR: `# SAP HR/HCM (Human Capital Management) — Best Practices

## Important Tables & Structures
- PA0001-PA0999 — HR master infotypes
- HRP1000/HRP1001 — OM objects/relationships
- PCL1/PCL2 — Payroll clusters
- PERNR — Personnel number (central entity)

## Recommended BAPIs & Classes
- HR_READ_INFOTYPE — Read infotype (standard FM)
- HR_INFOTYPE_OPERATION — Maintain infotype (INSS/MOD/DEL)
- RH_READ_OBJECT — Read OM objects
- CL_HR_PA_REQUEST_API — PA actions (newer API)

## Coding Guidelines
- Infotypes: ALWAYS use HR_READ_INFOTYPE / MACROS (RP-READ-INFOTYPE)
- NEVER write directly to PA tables!
- Authorizations: check HR auth via PERNR + INFTY + SUBTY
- Use logical database PNP/PNPCE for reports
- Time management: customize schemas via PCRs, do not hard-code

## Common Errors
- SELECT on PA tables without BEGDA/ENDDA logic
- Reading cluster tables (PCL*) directly instead of via macros
- Missing consideration of validity periods
- MOLGA-dependent logic not accounted for

## S/4HANA Migration
- SAP SuccessFactors for cloud HCM
- On-premise: HCM for S/4HANA (compatibility package)
- Employee Central as master for master data`,

  PS: `# SAP PS (Project System) — Best Practices

## Important Tables & Structures
- PROJ — Project definition
- PRPS — WBS elements
- AUFK — PS networks/orders
- AFVC — Operations
- BPGE/BPJA — Budget values

## Recommended BAPIs & Classes
- BAPI_PS_INITIALIZATION — Initialize PS APIs
- BAPI_PS_CREATE_WBS_ELEMENT — Create WBS element
- BAPI_NETWORK_MAINTAIN — Maintain network
- BAPI_PROJECT_MAINTAIN — Maintain project

## Coding Guidelines
- PS APIs always in buffer mode (INIT → operations → SAVE)
- Project hierarchy: build top-down
- Budget: via BAPIs, not directly on BPGE
- Scheduling: use standard scheduling functions

## Common Errors
- BAPI_PS_PRECOMMIT before BAPI_TRANSACTION_COMMIT forgotten
- Hierarchy levels mixed up
- Status profile not considered

## S/4HANA Migration
- Commercial Project Management (CPM)
- CDS Views: I_Project, I_WBSElement`,

  WM: `# SAP WM/EWM (Warehouse Management) — Best Practices

## Important Tables & Structures
- LQUA — Quants (warehouse stock)
- LTAP/LTAK — Transfer orders
- LAGP — Storage bins
- T300/T301 — Warehouse/storage type customizing
- LEIN — Handling units

## Recommended BAPIs & Classes
- BAPI_WHSE_TO_CREATE_STOCK — Create transfer order
- L_TO_CREATE_MOVE_SU — TO for handling unit
- BAPI_WHSE_STOCK_GET_LIST — Read stock

## Coding Guidelines
- Transfer orders: always via BAPIs/standard function modules
- Storage bin determination: configure putaway strategies, do not hard-code
- Inventory: use standard transactions MI*/LI*

## Common Errors
- Directly modifying quant table (LQUA)
- Missing confirmation of transfer orders
- WM-MM integration: stock differences due to missing TO confirmation

## S/4HANA Migration
- WM → EWM (embedded or decentralized)
- Stock Room Management as simpler alternative
- EWM: /SCWM/ namespace, CDS Views available`,

  EWM: `# SAP EWM (Extended Warehouse Management) — Best Practices

## Important Tables & Structures
- /SCWM/AQUA — Quants
- /SCWM/ORDIM_O — Warehouse Tasks
- /SCWM/LAGP — Storage Bins
- /SCWM/WHO — Warehouse Orders

## Recommended Classes
- /SCWM/CL_WM_PACKING — Packing logic
- /SCWM/CL_SR_BOM — BOMs in warehouse
- PPF (Post Processing Framework) for automation

## Coding Guidelines
- BAdIs for process customization (e.g. /SCWM/EX_HUOPT)
- Create warehouse tasks via standard APIs
- Use RF framework for mobile dialogs

## Common Errors
- Direct table manipulation instead of using APIs
- EWM-ERP integration: IDoc processing not monitored
- Missing exception handling for /SCWM/ APIs

## S/4HANA Migration
- Embedded EWM available directly in S/4HANA
- Decentralized EWM for complex scenarios`,

  BASIS: `# SAP BASIS/BC — Best Practices

## Important Tables & Structures
- USR02 — User master
- TVARVC — Selection variables
- TBTCO/TBTCP — Job overview
- E070/E071 — Transports
- TADIR — Object catalog

## Recommended Classes & FMs
- CL_LOG_PPF — Application Log
- BAL_LOG_CREATE / BAL_LOG_MSG_ADD — Application Log (classic)
- JOB_OPEN / JOB_SUBMIT / JOB_CLOSE — Background processing
- CL_BCS — Business Communication Services (e-mail)
- CL_GUI_FRONTEND_SERVICES — File up/download

## Coding Guidelines
- Logging: use Application Log (BAL) or CL_LOG_PPF, not WRITE
- Jobs: JOB_OPEN/SUBMIT/CLOSE for background processing
- Authorizations: AUTHORITY-CHECK always with specific objects
- Configuration: TVARVC for variable parameters instead of hard-coding
- Locks: Enqueue/Dequeue FMs for own lock objects

## Common Errors
- AUTHORITY-CHECK forgotten or too generic
- Lock objects not released (Enqueue without Dequeue)
- Hard-coded client/system numbers
- COMMIT WORK in update-task FMs

## S/4HANA Migration
- ABAP Platform: cloud-capable ABAP
- Respect released APIs (whitelist)
- CL_ABAP_CONTEXT_INFO instead of SY-UNAME/SY-DATUM directly`,

  ABAP: `# ABAP — General Best Practices

## Clean ABAP Principles
- Inline declarations: DATA(lv_var), FIELD-SYMBOL(<fs>)
- String templates: |Text { lv_var }| instead of CONCATENATE
- NEW #() / VALUE #() / CONV #() — constructor expressions
- COND #() / SWITCH #() instead of IF/CASE for assignments
- REDUCE #() for aggregations
- FILTER #() instead of LOOP + IF

## Modern ABAP SQL
- SELECT ... INTO TABLE @DATA(lt_result) — host variables with @
- SELECT ... FROM ... JOIN — instead of FOR ALL ENTRIES
- CDS Views for complex queries
- ABAP SQL aggregations instead of ABAP LOOP + COLLECT

## OOP Guidelines
- Classes/interfaces instead of function modules for new logic
- Dependency injection via interfaces (testability)
- Respect SOLID principles
- Exceptions: CX_* classes, TRY/CATCH instead of SY-SUBRC

## Performance
- SELECT only required fields, never SELECT *
- Internal tables: SORTED/HASHED TABLE for frequent access
- PARALLEL CURSOR for nested LOOPs
- Buffering: configure table buffering, use single-record buffer
- FOR ALL ENTRIES: check for duplicates and empty table!

## Avoiding Obsolete Statements
- MOVE → = (assignment)
- COMPUTE → direct calculation
- CHECK in methods → IF + RETURN
- FORM/PERFORM → methods
- Header-line tables → separate work area

## Testability
- ABAP Unit: CL_ABAP_UNIT_ASSERT
- Test doubles: CL_ABAP_TESTDOUBLE
- Test seams: IF_OSQL_TEST_ENVIRONMENT for DB
- SQL Test Double Framework

## S/4HANA Compatibility
- Check released APIs (whitelist approach)
- Use CL_ABAP_CONTEXT_INFO
- RAP (RESTful ABAP Programming) for new apps
- CDS Views as central data models`,
};

// Aliases: HCM → HR, BC → BASIS
MODULE_BEST_PRACTICES["HCM"] = MODULE_BEST_PRACTICES["HR"];
MODULE_BEST_PRACTICES["BC"] = MODULE_BEST_PRACTICES["BASIS"];

// ============================================================================
// WRITE SOURCE WORKFLOW (lock → write → check → activate → unlock)
// ============================================================================

function formatActivationMessages(messages: ActivationResultMessage[]): string[] {
  return messages.map(m =>
    `  [${m.type}] ${m.shortText}${m.line ? ` (line ${m.line})` : ""}${m.objDescr ? ` — ${m.objDescr}` : ""}`
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
  onProgress?: (msg: string) => Promise<void>,
): Promise<{ success: boolean; log: string[]; syntaxErrors?: string[] }> {
  return withWriteLock(() => withStatefulSession(client, async () => {
    const log: string[] = [];
    let lockHandle: string | undefined;
    try {
      // Phase 1: lock → write → unlock (stateful session needed for lock/write)
      log.push(`🔒 Locking: ${objectUrl}`);
      // Direct lock — withStatefulSession already manages the session
      const lock = await client.lock(objectUrl);
      lockHandle = lock.LOCK_HANDLE;
      if (!lockHandle) throw new Error("Lock failed — no lock handle received");
      log.push(`✅ Lock acquired`);
      await onProgress?.("🔒 Lock acquired");

      log.push(`✏️  Writing source code (${source.length} characters)...`);
      const sourceUrl = objectUrl.endsWith("/source/main") ? objectUrl : `${objectUrl}/source/main`;
      await client.setObjectSource(sourceUrl, source, lockHandle, transport || undefined);
      log.push("✅ Source code saved");
      await onProgress?.("✏️ Source code saved");

      // Early DDIC validation prevents typical infinite loops caused by field name errors
      const ddicCheck = await validateDdicReferencesInternal(client, source);
      if (ddicCheck.tableCount > 0) {
        log.push(`🔎 DDIC validation: ${ddicCheck.tableCount} tables/structures checked`);
      }
      if (ddicCheck.invalid.length > 0) {
        log.push("❌ DDIC validation failed — code NOT activated.");
        log.push(...ddicCheck.invalid.slice(0, 50));
        if (ddicCheck.invalid.length > 50) {
          log.push(`... and ${ddicCheck.invalid.length - 50} more DDIC errors`);
        }
        log.push("👉 Please fix the invalid field names and call write_abap_source again.");
        return { success: false, log, syntaxErrors: ddicCheck.invalid };
      }

      // Phase 2: unlock + syntaxCheck in parallel (no lock needed for check)
      log.push("🔓 Releasing lock + 🔍 Syntax check (parallel)...");
      const syntaxContext = await resolveSyntaxContext(client, objectUrl, mainProgram, log);
      const [, syntaxRes] = await Promise.all([
        client.unLock(objectUrl, lockHandle).catch((e) => {
          log.push(`⚠️ Unlock failed: ${e instanceof Error ? e.message : String(e)}`);
        }),
        !skipCheck
          ? client.syntaxCheck(objectUrl, syntaxContext, source).catch((e) => {
              log.push(`⚠️ Syntax check failed: ${e instanceof Error ? e.message : String(e)}`);
              return null; // null = check failed
            })
          : Promise.resolve(undefined),
      ]);
      lockHandle = undefined;
      log.push("✅ Lock released");

      // Process syntaxRes (undefined = skipped, null = error, array = result)
      if (!skipCheck && syntaxRes !== undefined) {
        if (syntaxRes === null) {
          log.push("👉 Syntax check skipped — code was saved. Please check manually.");
          return { success: false, log };
        }
        const errs = (Array.isArray(syntaxRes) ? syntaxRes : []).filter(
          (m: { severity: string }) => ["E", "A"].includes(m.severity));
        if (errs.length > 0) {
          const msgs = errs.map((e: { text: string; line?: number }) => `  Line ${e.line ?? "?"}: ${e.text}`);
          log.push(`❌ ${errs.length} syntax error(s) — code NOT activated.`);
          log.push("👉 Please fix the errors and call write_abap_source again!");
          return { success: false, log, syntaxErrors: msgs };
        }
        log.push("✅ Syntax check OK");
        await onProgress?.("🔍 Syntax check OK — activating...");
      }

      if (activate) {
        log.push("🚀 Activating...");
        const segments = objectUrl.replace(/[?#].*$/, "").split("/").filter(Boolean);
        const name = segments[segments.length - 1] ?? objectUrl;

        // Include programs need the main program as context for activation,
        // because they cannot be activated alone (they reference variables of the main program).
        let activationContext: string | undefined;
        const isInclude = objectUrl.includes("/programs/includes/");
        if (isInclude) {
          const resolvedMain = resolveMainProgram(mainProgram);
          if (resolvedMain) {
            activationContext = resolvedMain;
            log.push(`📎 Include — activating in context of: ${mainProgram}`);
          } else {
            // Automatically determine main program
            try {
              const mains = await client.mainPrograms(objectUrl);
              if (mains.length > 0) {
                activationContext = mains[0]["adtcore:uri"];
                log.push(`📎 Include — main program automatically determined: ${mains[0]["adtcore:name"]}`);
              }
            } catch (mpErr) {
              log.push(`⚠️  Main program could not be determined: ${String(mpErr instanceof Error ? mpErr.message : mpErr)}`);
            }
          }
        }

        const activationResult = await client.activate(name, objectUrl, activationContext);
        if (!activationResult.success) {
          const msgs = formatActivationMessages(activationResult.messages);
          log.push(`❌ Activation failed — code was saved but NOT activated.`);
          if (msgs.length > 0) log.push(...msgs);
          log.push("👉 Please analyze the errors, fix the code and call write_abap_source again!");
          return { success: false, log };
        }
        if (activationResult.messages.length > 0) {
          log.push("✅ Activated (with notices):");
          log.push(...formatActivationMessages(activationResult.messages));
        } else {
          log.push("✅ Activated");
        }
        await onProgress?.("✅ Activated");
      }

      return { success: true, log };
    } catch (err) {
      if (lockHandle) {
        try { await client.unLock(objectUrl, lockHandle); log.push("🔓 Lock released after error"); }
        catch { log.push("⚠️  Lock could not be released — dropSession in finally will clean up"); }
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
    description: "Search for ABAP objects by name pattern. Wildcards (*) are supported. Returns name, type, ADT URI and package. Supports 30+ object types (programs, classes, function groups, CDS, tables, domains, data elements, messages, etc.).",
    schema: S_Search },

  // ── READ ────────────────────────────────────────────────────────────────
  { name: "read_abap_source",
    description: "Reads the source code of an ABAP object. With includeRelated=true all related objects are automatically read: class includes (definitions, implementations, macros, test classes), program includes (INCLUDE statements resolved), function groups (all function modules). Recommendation: use includeRelated=true to understand the full context before making changes.",
    schema: S_ReadSource },
  { name: "get_object_info",
    description: "Reads detailed metadata and structure of an object: methods, attributes, includes, enqueue info, DDIC fields, etc.",
    schema: S_ObjectInfo },
  { name: "where_used",
    description: "Finds all usage locations of an object in the system (programs, classes, other objects). Basis for impact analysis.",
    schema: S_WhereUsed },
  { name: "get_code_completion",
    description: "Fetches code completion suggestions from the SAP system for a specific cursor position. Returns system-specific suggestions from the real context (method names, attributes, parameters, etc.).",
    schema: S_CodeCompletion },

  // ── WRITE ───────────────────────────────────────────────────────────────
  { name: "write_abap_source",
    description: "Writes source code to an existing ABAP object and activates it. Executes the full ADT workflow: lock → write → syntax check → activate → unlock.\n" +
      "✅ PREFERRED: Use 'sourcePath' — write the source to a local temp file first (e.g. /tmp/zsource.abap), then pass the path. This is faster, cheaper, and avoids JSON escaping issues. " +
      "Use inline 'source' only for very short snippets (< 20 lines).\n" +
      "⚠️ IMPORTANT: After the call, the object MUST be activated. If syntax or activation errors occur, fix the source and retry. " +
      "Stop only if the SAME error persists after 3 attempts. If DIFFERENT errors appear, keep iterating — that means progress is being made.\n" +
      "**Before the first write:** Call `validate_ddic_references` with the planned code to catch invalid field names early.\n" +
      "**Comments:** Full-line comments with `*` MUST start in column 1 (no indentation). For indented comments use `\"` instead.\n" +
      "⚠️ Requires ALLOW_WRITE=true.",
    schema: S_WriteSource },
  { name: "activate_abap_object",
    description: "Activates an already saved ABAP object. Useful after manual changes or for reactivation after errors. ⚠️ Requires ALLOW_WRITE=true.",
    schema: S_Activate },
  { name: "mass_activate",
    description: "Activates multiple ABAP objects in one step. Useful after dependent changes (e.g. interface + implementation). ⚠️ Requires ALLOW_WRITE=true.",
    schema: S_MassActivate },
  { name: "pretty_print",
    description: "Formats ABAP source code via the SAP Pretty Printer. Indentation and keyword capitalization are configured server-side (SE38 → Settings). Returns formatted code without saving.",
    schema: S_PrettyPrint },

  // ── CREATE ──────────────────────────────────────────────────────────────
  { name: "create_abap_program",
    description: "Creates a new ABAP program. programType='P' for report (default), programType='I' for include. Name must start with Z or Y. ⚠️ Requires ALLOW_WRITE=true.",
    schema: S_CreateProgram },
  { name: "create_abap_class",
    description: "Creates a new ABAP class. Name must start with ZCL_ or YCL_. ⚠️ Requires ALLOW_WRITE=true.",
    schema: S_CreateClass },
  { name: "create_abap_interface",
    description: "Creates a new ABAP interface. Name must start with ZIF_ or YIF_. ⚠️ Requires ALLOW_WRITE=true.",
    schema: S_CreateInterface },
  { name: "create_function_group",
    description: "Creates a new function group. Name must start with Z or Y. ⚠️ Requires ALLOW_WRITE=true.",
    schema: S_CreateFunctionGroup },
  { name: "create_cds_view",
    description: "Creates a new CDS view (DDLS). Name must start with Z or Y. ⚠️ Requires ALLOW_WRITE=true.",
    schema: S_CreateCdsView },
  { name: "create_database_table",
    description: "Creates a new transparent database table (TABL). Name must start with Z or Y. ⚠️ Requires ALLOW_WRITE=true.",
    schema: S_CreateTable },
  { name: "create_message_class",
    description: "Creates a new message class (MSAG). Name must start with Z or Y. ⚠️ Requires ALLOW_WRITE=true.",
    schema: S_CreateMessageClass },

  // ── DELETE ──────────────────────────────────────────────────────────────
  { name: "delete_abap_object",
    description: "Permanently deletes an ABAP object. ⛔ CANNOT BE UNDONE. Requires ALLOW_DELETE=true and ALLOW_WRITE=true.",
    schema: S_DeleteObject },

  // ── TEST ────────────────────────────────────────────────────────────────
  { name: "run_unit_tests",
    description: "Runs ABAP Unit Tests for a class or program. Returns test results with pass/fail status and error messages.",
    schema: S_RunTests },
  { name: "create_test_include",
    description: "Creates a test include (CCAU) for an existing class. Generates the basic structure for ABAP Unit Tests. ⚠️ Requires ALLOW_WRITE=true.",
    schema: S_CreateTestInclude },

  // ── QUALITY ─────────────────────────────────────────────────────────────
  { name: "run_syntax_check",
    description: "Runs an ABAP syntax check without saving. Returns errors and warnings with line numbers.",
    schema: S_SyntaxCheck },
  { name: "run_atc_check",
    description: "Starts an ATC check (ABAP Test Cockpit) for an object. Returns code quality findings with priority, category and description.",
    schema: S_RunAtc },
  { name: "validate_ddic_references",
    description:
      "Statically analyzes ABAP source code and checks all referenced table fields against DDIC metadata. " +
      "Returns a list of invalid field names. " +
      "⚡ Recommended to call before write_abap_source to avoid 'Field unknown' syntax errors. " +
      "Detects: (1) TYPE/LIKE tab-field, (2) table~field (New SQL), (3) SELECT field list FROM table, (4) WHERE clause fields.",
    schema: S_ValidateDdic },

  // ── DIAGNOSTICS ─────────────────────────────────────────────────────────
  { name: "get_short_dumps",
    description: "Reads the list of the latest short dumps (runtime errors) from the system. Corresponds to transaction ST22.",
    schema: S_GetDumps },
  { name: "get_short_dump_detail",
    description: "Reads details of a specific short dump: error text, call stack, local variables, source code position.",
    schema: S_GetDumpDetail },
  { name: "get_traces",
    description: "Reads the list of performance traces (SQL trace, ABAP trace). Corresponds to transaction SAT.",
    schema: S_GetTraces },
  { name: "get_trace_detail",
    description: "Reads details of a specific performance trace: runtime, hit count, most expensive statements.",
    schema: S_GetTraceDetail },

  // ── TRANSPORT ───────────────────────────────────────────────────────────
  { name: "get_transport_info",
    description: "Returns available transport requests for an object and its package.",
    schema: S_TransportInfo },
  { name: "get_transport_objects",
    description: "Lists all objects in a transport request. Shows what a transport contains.",
    schema: S_TransportObjects },

  // ── ABAPGIT ─────────────────────────────────────────────────────────────
  { name: "get_abapgit_repos",
    description: "Lists all abapGit repositories configured in the system.",
    schema: S_GitRepos },
  { name: "abapgit_pull",
    description: "Performs an abapGit pull for a repository (imports code from Git). ⚠️ Requires ALLOW_WRITE=true.",
    schema: S_GitPull },

  // ── QUERY ───────────────────────────────────────────────────────────────
  { name: "run_select_query",
    description: "Executes a SELECT statement directly against SAP tables. Returns result rows as JSON. Only read-only access is allowed.",
    schema: S_Query },
  { name: "execute_abap_snippet",
    description:
      "Executes a temporary ABAP code snippet live in the SAP system and returns the output. " +
      "The program is created in $TMP, executed immediately and then automatically deleted — no permanent state. " +
      "Ideal for: checking table values, testing calculations, inspecting API return values, validating debugging hypotheses. " +
      "⚠️ Requires ALLOW_WRITE=true. " +
      "⚠️ Use read-only logic only — COMMIT WORK, BAPI calls and write DB operations are forbidden. " +
      "The tool statically checks the code for forbidden statements before executing it.",
    schema: S_ExecuteSnippet },

  // ── NEW TOOLS ─────────────────────────────────────────────────────────────
  { name: "find_definition",
    description: "Navigates to the definition of a token (variable, method, class, etc.) in source code. Returns URI, line and column of the definition.",
    schema: S_FindDefinition },
  { name: "get_revisions",
    description: "Reads the version history of an ABAP object. Returns all saved revisions with date, author and transport request.",
    schema: S_GetRevisions },
  { name: "create_transport",
    description: "Creates a new transport request. Returns the transport number. ⚠️ Requires ALLOW_WRITE=true.",
    schema: S_CreateTransport },
  { name: "get_fix_proposals",
    description: "Fetches quick-fix proposals for a specific position in source code (e.g. implement missing method, declare variable).",
    schema: S_FixProposals },
  { name: "get_ddic_element",
    description: "Reads detailed DDIC information for a table, view, data element or domain. Returns fields, types, annotations and associations.",
    schema: S_GetDdicElement },
  { name: "get_inactive_objects",
    description: "Lists all inactive (not yet activated) objects of the current user.",
    schema: S_GetInactiveObjects },
  { name: "get_table_contents",
    description: "Reads table contents directly from a DDIC table. Returns data as JSON.",
    schema: S_GetTableContents },

  // ── CONTEXT ANALYSIS ──────────────────────────────────────────────────
  { name: "analyze_abap_context",
    description: "Analyzes the complete context of an ABAP object: reads source code including all includes, detects referenced function modules, classes and interfaces via regex, retrieves their metadata and returns a structured context report. Entry point for the abap_develop workflow.",
    schema: S_AnalyzeContext },

  // ── DOCUMENTATION ─────────────────────────────────────────────────────
  { name: "get_abap_keyword_doc",
    description: "Fetches ABAP keyword documentation from help.sap.com (e.g. SELECT, LOOP, READ TABLE). Returns the official SAP documentation as formatted text.",
    schema: S_GetAbapKeywordDoc },
  { name: "get_abap_class_doc",
    description: "Fetches ABAP class/interface documentation from help.sap.com (e.g. CL_SALV_TABLE, IF_AMDP_MARKER_HDB). Returns the official SAP documentation as formatted text.",
    schema: S_GetAbapClassDoc },
  { name: "get_module_best_practices",
    description: "Returns module-specific SAP ABAP best practices (important tables, recommended BAPIs/classes, coding guidelines, common errors, S/4HANA migration hints). Modules: FI, CO, MM, SD, PP, PM, QM, HR, HCM, PS, WM, EWM, BASIS, BC, ABAP.",
    schema: S_GetModuleBestPractices },
  { name: "search_clean_abap",
    description: "Searches the official SAP Clean ABAP Styleguide (github.com/SAP/styleguides) for best practices, naming conventions, coding guidelines and anti-patterns. " +
      "Returns the most relevant sections. Call before writing new code to comply with Clean ABAP conventions.",
    schema: S_SearchCleanAbap },
  { name: "search_abap_syntax",
    description: "Searches the official ABAP syntax documentation from help.sap.com based on a free-text query (e.g. 'SELECT UP TO ROWS', 'LOOP AT clause order'). " +
      "Automatically identifies the main keyword, loads the documentation page and returns the relevant syntax section. " +
      "Call BEFORE writing ABAP code to ensure correct syntax.",
    schema: S_SearchAbapSyntax },
  { name: "review_clean_abap",
    description:
      "Reviews ABAP source code for Clean ABAP compliance. " +
      "Detects anti-patterns (Hungarian notation, MOVE/COMPUTE/CONCATENATE, FORM subroutines, " +
      "SELECT...ENDSELECT loops, sy-subrc checks, CALL METHOD) and returns findings with " +
      "relevant Clean ABAP guideline excerpts. " +
      "No SAP system connection required — pure static analysis. " +
      "Call on existing code before writing to understand current conventions.",
    schema: S_ReviewCleanAbap },
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
  QUALITY:     ["run_syntax_check", "run_atc_check", "validate_ddic_references", "review_clean_abap"],
  DIAGNOSTICS: ["get_short_dumps", "get_short_dump_detail", "get_traces", "get_trace_detail"],
  TRANSPORT:   ["get_transport_info", "get_transport_objects", "create_transport"],
  ABAPGIT:     ["get_abapgit_repos", "abapgit_pull"],
  QUERY:       ["run_select_query", "get_inactive_objects", "execute_abap_snippet"],
  DOCUMENTATION: ["get_abap_keyword_doc", "get_abap_class_doc", "get_module_best_practices", "search_abap_syntax", "search_clean_abap"],
};

const CORE_TOOL_NAMES = new Set([
  "find_tools",
  "search_abap_objects",
  "read_abap_source",
  "write_abap_source",
  "get_object_info",
  "where_used",
  "analyze_abap_context",
  "search_abap_syntax",       // mandatory in abap_develop Step 5.1
  "validate_ddic_references", // mandatory in abap_develop Step 5.3
]);

const enabledTools = new Set<string>();

const S_FindTools = z.object({
  query: z.string().optional().describe("Search pattern for tool names/descriptions"),
  category: z.string().optional().describe(
    "Category: SEARCH | READ | WRITE | CREATE | DELETE | TEST | QUALITY | DIAGNOSTICS | TRANSPORT | ABAPGIT | QUERY | DOCUMENTATION"
  ),
  enable: z.boolean().optional().default(true).describe("Enable tools (default: true)"),
});

const FIND_TOOLS_ENTRY = {
  name: "find_tools",
  description: "Finds and enables ABAP tools by search term or category. " +
    "⚠️ Most tools are deferred — call this BEFORE using any non-core tool! " +
    "Categories: SEARCH, READ, WRITE, CREATE, DELETE, TEST, " +
    "QUALITY (syntax check, ATC, Clean ABAP review, DDIC validation), " +
    "DIAGNOSTICS (short dumps, traces), TRANSPORT, ABAPGIT, QUERY, " +
    "DOCUMENTATION (ABAP syntax help). " +
    "Enabled tools become immediately available.",
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
    description: "Intelligent ABAP development workflow: First analyzes the complete context, applies modern ABAP principles.",
    arguments: [
      { name: "object_name", description: "Name of the ABAP object (e.g. ZRYBAK_TEST)", required: true },
      { name: "task", description: "Task (e.g. 'Add ALV grid with CL_SALV_TABLE')", required: true },
    ],
  }],
}));

// ── GET PROMPT ──────────────────────────────────────────────────────────────
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: promptArgs } = request.params;
  if (name !== "abap_develop")
    throw new McpError(ErrorCode.InvalidRequest, `Unknown prompt: ${name}`);

  const objectName = promptArgs?.object_name ?? "";
  const task = promptArgs?.task ?? "";

  return {
    messages: [{
      role: "user",
      content: {
        type: "text",
        text:
`You are an experienced SAP ABAP developer. Your task: "${task}" on object "${objectName}".

## MANDATORY WORKFLOW (follow the order!)

### Step 1: Gather the complete context
1. Run \`search_abap_objects(query="${objectName}")\` to determine the ADT URL.
2. Run \`analyze_abap_context(objectUrl=<url>, depth="deep")\`.
3. Read the context report COMPLETELY before proceeding to step 2.
   ⚠️ NEVER write code without having read ALL includes and referenced objects first!

### Step 2: Research references & alternatives
- For each function module found in the context: check whether modern alternatives exist.
  Examples of outdated patterns → modern alternatives:
    • REUSE_ALV_GRID_DISPLAY → CL_SALV_TABLE / CL_GUI_ALV_GRID
    • POPUP_TO_CONFIRM → IF_FPM_POPUP (for FPM) or custom class
    • READ TABLE ... SY-SUBRC → inline declaration: READ TABLE ... INTO DATA(ls_row)
    • CALL FUNCTION (without exceptions) → TRY/CATCH with CX_* classes
    • WRITE / FORMAT → CL_SALV_TABLE or Web Dynpro / Fiori
- Use \`search_abap_objects\` and \`where_used\` to find alternatives in the system.
- When uncertain: search the SAP documentation (web search) for best practices.

### Step 3: Apply modern ABAP principles (Clean ABAP)
**Before coding:** Call \`find_tools(category="QUALITY")\` if not yet done, then run
\`review_clean_abap(source=<existing_code>)\` on the current source to identify existing
anti-patterns and coding conventions before writing new code.

Follow these principles when coding:
- **Inline declarations**: DATA(lv_var), FIELD-SYMBOL(<fs>), NEW #(), VALUE #()
- **String templates**: |Text { lv_var } more text| instead of CONCATENATE
- **Functional methods**: COND #(), SWITCH #(), REDUCE #(), FILTER #()
- **ABAP SQL**: SELECT ... INTO TABLE @DATA(lt_result) (host variables with @)
- **Exceptions**: CX_* classes and TRY/CATCH instead of SY-SUBRC checks
- **OOP**: Classes/interfaces instead of function modules for new logic
- **Naming**: Clean ABAP conventions (no Hungarian notation for new objects,
  but respect existing conventions in the program)
- **Avoid**: MOVE, COMPUTE, obsolete statements (CHECK in methods → RETURN)
- **Testability**: Inject dependencies via interfaces

### Step 3b: ABAP Syntax Rules — MEMORIZE before writing code

**SELECT / ABAP SQL:**
- ✅ Modern (preferred): \`SELECT f1 f2 FROM ztab WHERE k = @lv_k INTO TABLE @DATA(lt) ORDER BY f1 DESCENDING.\`
  ORDER BY, UP TO n ROWS, GROUP BY → only valid in this single-statement form.
- Old loop style: \`SELECT f1 FROM ztab WHERE k = @lv_k INTO lv_v. ... ENDSELECT.\`
  ⛔ ORDER BY is NOT allowed in SELECT...ENDSELECT loops — use SORT after the loop.
  ⛔ Every SELECT...ENDSELECT loop MUST be closed with ENDSELECT before ENDMETHOD/ENDFORM.
  ⛔ NEVER mix styles (no INTO TABLE inside a SELECT...ENDSELECT).

**SORT:**
- ✅ \`SORT lt_table BY field1 ASCENDING field2 DESCENDING.\`
- ASCENDING/DESCENDING are **keywords**, not parameters.
  ⛔ NEVER write \`SORT lt BY f DESCENDING = 'X'.\` — syntax error!

**WRITE ... CURRENCY:**
- ✅ \`WRITE lv_amount CURRENCY lv_waers TO lv_output.\` (lv_output must be CHAR/STRING)
- CURRENCY is a formatting **keyword** here, not a field name.
  ⛔ NEVER use CURRENCY as a variable name in a WRITE statement.

**Comments:**
- Full-line comments use \`*\` in **column 1** (the very first character of the line).
  ⛔ NEVER indent \`*\` — any whitespace before \`*\` is a syntax error!
  ✅ \`* This is a comment\` (column 1)
  ⛔ \`  * This is NOT a valid comment\` (indented — syntax error)
- For indented/inline comments use \`"\`: \`  " This is an indented comment\`

**Type compatibility:**
- Integer literals are type I by default.
  ⛔ NEVER pass a raw integer literal to CURRENCY/AMOUNT typed formal parameters.
- For string conversion use: \`lv_str = |{ lv_amount }|\` or \`WRITE lv_amount TO lv_str.\`

### Step 4: Determine code placement
- Check the context report: which include/class should the new code go into?
- For reports with includes: NEVER put code into the main program if a suitable include exists!
- For classes: choose the correct method / correct include
- For function groups: identify the correct function module

### Step 4b: Look up DDIC structures (MANDATORY for DB tables)
⚠️ **BEFORE writing code** that uses database fields:
1. Identify all tables/structures you want to reference in the code (e.g. VBAK, VBAP, KNA1, EKKO …).
2. For **each** of these tables call \`get_object_info(objectUrl=<adt-url-of-table>)\` — determine the ADT URL via \`search_abap_objects(query=<tablename>, objectType="TABL")\`.
3. Read the returned fields **completely** and remember the **exact** field names.
4. Use **only** field names in the code that you saw in step 3. NEVER invent or guess field names!

### Step 5: Implementation
⚠️ **MANDATORY before the first write_abap_source call:**
0. Ensure validation tools are available: if \`search_abap_syntax\` or \`validate_ddic_references\`
   are not in your tool list, call \`find_tools(category="DOCUMENTATION")\` and
   \`find_tools(category="QUALITY")\` now.
1. For each ABAP statement you want to use (SELECT, LOOP AT, SORT, WRITE, …): call
   \`search_abap_syntax(query=<statement>)\`. Pay attention to the rules in Step 3b.
2. Write the planned code based on verified field names (Step 4b) and syntax (Step 5.1).
3. Call \`validate_ddic_references(source=<planned_code>)\` — final verification.
4. If errors: fix field names. NEVER call \`write_abap_source\` if errors are reported!
5. Only when \`validate_ddic_references\` reports ✅ → call \`write_abap_source\`.

- For syntax/activation errors: analyze, fix, and retry. Only stop if the SAME error persists after 3 attempts. If DIFFERENT errors appear, keep iterating — progress is being made
- After implementation run \`run_syntax_check\` and optionally \`run_unit_tests\`

### Step 6: Quality check
- Run \`run_atc_check\` to ensure code quality
- Fix findings (priority 1 and 2)`,
      },
    }],
  };
});

// ── CALL TOOL ───────────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
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
          ? `No objects found for '${p.query}'`
          : `${items.length} object(s) found:\n\n${JSON.stringify(items, null, 2)}`);
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
          sections.push(`\n⚠️ Note: Some related objects could not be read: ${e?.message ?? e}`);
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
          ? "No usages found."
          : `${items.length} usage(s):\n\n${JSON.stringify(items, null, 2)}`);
      }

      // ── get_code_completion ─────────────────────────────────────────────
      case "get_code_completion": {
        const p = S_CodeCompletion.parse(args);
        const res = await client.codeCompletion(
          p.objectUrl, p.source, p.line, p.column
        );
        const items = Array.isArray(res) ? res : [];
        return ok(items.length === 0
          ? "No suggestions found."
          : `${items.length} suggestion(s):\n\n${JSON.stringify(items, null, 2)}`);
      }

      // ── write_abap_source ───────────────────────────────────────────────
      case "write_abap_source": {
        assertWriteEnabled();
        const p = S_WriteSource.parse(args);
        let source: string;
        if (p.sourcePath) {
          try {
            source = fs.readFileSync(p.sourcePath, "utf-8");
          } catch (e) {
            throw new McpError(ErrorCode.InvalidRequest,
              `Cannot read sourcePath '${p.sourcePath}': ${e instanceof Error ? e.message : String(e)}`);
          }
        } else {
          source = p.source!;
        }
        const progressToken = (extra as { _meta?: { progressToken?: string | number } })._meta?.progressToken;
        let step = 0;
        const totalSteps = 4;
        async function reportProgress(message: string) {
          if (progressToken === undefined) return;
          step++;
          await (extra as { sendNotification: (n: object) => Promise<void> }).sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress: step, total: totalSteps, message },
          });
        }
        const r = await writeWorkflow(
          client, p.objectUrl, source,
          p.transport ?? cfg.defaultTransport,
          p.activateAfterWrite ?? true,
          p.skipSyntaxCheck ?? false,
          p.mainProgram,
          reportProgress,
        );
        const body = r.log.join("\n") + (r.syntaxErrors ? "\n\nSyntax errors:\n" + r.syntaxErrors.join("\n") : "");
        if (r.success) {
          return ok(`✅ Successfully written and activated\n\n${body}`);
        }
        return err(`❌ Error — code NOT activated!\n\n${body}\n\n⚠️ ACTION REQUIRED: Analyze the errors above, fix the ABAP source code and call write_abap_source again. Repeat until activation succeeds.`);
      }

      // ── activate_abap_object ────────────────────────────────────────────
      case "activate_abap_object": {
        assertWriteEnabled();
        const p = S_Activate.parse(args);
        const activationResult = await client.activate(p.objectName, p.objectUrl);
        if (!activationResult.success) {
          const msgs = formatActivationMessages(activationResult.messages);
          return err(`❌ Activation of '${p.objectName}' failed\n${msgs.join("\n")}`);
        }
        const extra = activationResult.messages.length > 0
          ? `\n${formatActivationMessages(activationResult.messages).join("\n")}` : "";
        return ok(`✅ '${p.objectName}' successfully activated${extra}`);
      }

      // ── mass_activate ───────────────────────────────────────────────────
      case "mass_activate": {
        assertWriteEnabled();
        const p = S_MassActivate.parse(args);
        if (p.objects.length > 50)
          throw new McpError(ErrorCode.InvalidRequest, "Maximum 50 objects per mass activation.");
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
          return err(`❌ Mass activation failed (${p.objects.length} objects)\n${msgs.join("\n")}`);
        }
        const extra = msgs.length > 0 ? `\n\nNotices:\n${msgs.join("\n")}` : "";
        return ok(`✅ Mass activation: ${p.objects.length} object(s) successfully activated${extra}`);
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
        const label = progType === "I" ? "Include" : "Program";
        return ok(`✅ ${label} '${n}' created\nURI: ${url}\n\nNext steps:\n  write_abap_source with objectUrl='${url}'`);
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
        return ok(`✅ Class '${n}' created\nURI: ${url}\n\nNext steps:\n  read_abap_source → write_abap_source`);
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
        return ok(`✅ Interface '${n}' created\nURI: ${url}`);
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
        return ok(`✅ Function group '${n}' created\nURI: ${url}`);
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
        return ok(`✅ CDS View '${n}' created\nURI: ${url}`);
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
        return ok(`✅ Table '${n}' created\nURI: ${url}`);
      }

      // ── create_message_class ────────────────────────────────────────────
      case "create_message_class": {
        assertWriteEnabled();
        const p = S_CreateMessageClass.parse(args);
        assertPackageAllowed(p.devClass);
        assertCustomerNamespace(p.name, ["Z", "Y"]);
        const n = p.name.toUpperCase();
        await client.createObject("MSAG/N", n, p.devClass, p.description, `/sap/bc/adt/packages/${encodeURIComponent(p.devClass)}`, undefined, p.transport || undefined);
        return ok(`✅ Message class '${n}' created`);
      }

      // ── delete_abap_object ──────────────────────────────────────────────
      case "delete_abap_object": {
        assertWriteEnabled("Delete");
        assertDeleteEnabled();
        const p = S_DeleteObject.parse(args);
        await withWriteLock(() => withStatefulSession(client, async () => {
          const lock = await client.lock(p.objectUrl);
          try {
            await client.deleteObject(p.objectUrl, lock.LOCK_HANDLE, p.transport || undefined);
          } catch (e) {
            try { await client.unLock(p.objectUrl, lock.LOCK_HANDLE); } catch { /* ignore */ }
            throw e;
          }
        }));
        return ok(`✅ Object '${p.objectName}' deleted.\n⚠️  This action cannot be undone.`);
      }

      // ── run_unit_tests ──────────────────────────────────────────────────
      case "run_unit_tests": {
        const p = S_RunTests.parse(args);
        const results = await client.unitTestRun(p.objectUrl);
        if (!results || results.length === 0) return ok("No unit test results — are tests present?");
        let passed = 0, failed = 0;
        for (const cls of results) {
          for (const method of cls.testmethods ?? []) {
            if (method.alerts && method.alerts.length > 0) failed++;
            else passed++;
          }
        }
        const summary = `Unit tests: ${passed} passed, ${failed} failed`;
        return (failed === 0 ? ok : err)(`${failed === 0 ? "✅" : "❌"} ${summary}\n\n${JSON.stringify(results, null, 2)}`);
      }

      // ── create_test_include ─────────────────────────────────────────────
      case "create_test_include": {
        assertWriteEnabled();
        const p = S_CreateTestInclude.parse(args);
        await withWriteLock(() => withStatefulSession(client, async () => {
          const lock = await client.lock(p.classUrl);
          try {
            await client.createTestInclude(p.classUrl, lock.LOCK_HANDLE);
            await client.unLock(p.classUrl, lock.LOCK_HANDLE);
          } catch (e) {
            try { await client.unLock(p.classUrl, lock.LOCK_HANDLE); } catch { /* ignore */ }
            throw e;
          }
        }));
        return ok(`✅ Test include created for ${p.classUrl}`);
      }

      // ── run_syntax_check ────────────────────────────────────────────────
      case "run_syntax_check": {
        const p = S_SyntaxCheck.parse(args);
        const syntaxContext = await resolveSyntaxContext(client, p.objectUrl, p.mainProgram);
        const res = await client.syntaxCheck(p.objectUrl, syntaxContext, p.source);
        const msgs     = Array.isArray(res) ? res : [];
        const errors   = msgs.filter((m: { severity: string }) => ["E", "A"].includes(m.severity));
        const warnings = msgs.filter((m: { severity: string }) => m.severity === "W");
        const summary  = errors.length === 0
          ? `✅ Syntax OK${warnings.length > 0 ? ` (${warnings.length} warning(s))` : ""}`
          : `❌ ${errors.length} error(s), ${warnings.length} warning(s)`;
        return (errors.length === 0 ? ok : err)(`${summary}\n\n${JSON.stringify(msgs, null, 2)}`);
      }

      // ── run_atc_check ───────────────────────────────────────────────────
      case "run_atc_check": {
        const p = S_RunAtc.parse(args);
        const variant = p.checkVariant ?? "DEFAULT";
        const runResult = await client.createAtcRun(variant, p.objectUrl);
        const worklist = await client.atcWorklists(runResult.id);
        const findings = worklist.objects ?? [];
        if (findings.length === 0) return ok("No ATC findings — object is clean.");
        const summary = `ATC: ${findings.length} object(s) with findings`;
        return ok(`${summary}\n\n${JSON.stringify(worklist, null, 2)}`);
      }

      // ── validate_ddic_references ────────────────────────────────────────
      case "validate_ddic_references": {
        const p = S_ValidateDdic.parse(args);
        const source = p.source;

        // Extrahiere alle "TABLE-FIELD"-Referenzen aus gängigen ABAP-Patterns
        const tableFieldMap = new Map<string, Set<string>>(); // tableName → Set<fieldName>

        const patterns = [
          // TYPE tablename-fieldname
          /\bTYPE\s+([A-Z][A-Z0-9_]{1,30})-([A-Z][A-Z0-9_]{1,30})\b/gi,
          // LIKE tablename-fieldname
          /\bLIKE\s+([A-Z][A-Z0-9_]{1,30})-([A-Z][A-Z0-9_]{1,30})\b/gi,
        ];

        // Helper: Tabellen-/Feldname zur Map hinzufügen mit Standardfiltern
        const skipTable = (t: string) =>
          /^[LG][TSVO]_/.test(t) || /^[LG]S_/.test(t) ||
          /^(C|N|I|F|P|X|D|T|STRING|XSTRING|ABAP_.*)$/.test(t);

        const SQL_KW = new Set([
          'SINGLE','DISTINCT','COUNT','SUM','AVG','MIN','MAX','AS','CASE','WHEN',
          'THEN','ELSE','END','UP','TO','ROWS','APPENDING','CORRESPONDING','FIELDS',
          'OF','TABLE','INTO','FOR','ALL','ENTRIES','IN','AND','OR','NOT',
          'ORDER','BY','GROUP','HAVING','INNER','LEFT','RIGHT','OUTER','JOIN','ON',
          'CROSS','UNION','EXCEPT','INTERSECT','EXISTS','BETWEEN','LIKE','IS','NULL',
          'ASCENDING','DESCENDING','CLIENT','SPECIFIED','BYPASSING','BUFFER','CONNECTION',
          'WHERE','FROM','SELECT','UPDATE','DELETE','INSERT','MODIFY','DATA','VALUE',
        ]);

        const addField = (t: string, f: string) => {
          if (skipTable(t) || SQL_KW.has(f)) return;
          if (!tableFieldMap.has(t)) tableFieldMap.set(t, new Set());
          tableFieldMap.get(t)!.add(f);
        };

        // ── Pattern 1+2: TYPE/LIKE table-field ──
        for (const pattern of patterns) {
          let m: RegExpExecArray | null;
          while ((m = pattern.exec(source)) !== null) {
            addField(m[1].toUpperCase(), m[2].toUpperCase());
          }
        }

        // ── Pattern 3: table~field (New ABAP SQL Syntax) ──
        const tildePattern = /\b([A-Z][A-Z0-9_]{2,30})~([A-Z][A-Z0-9_]{1,30})\b/gi;
        let tm: RegExpExecArray | null;
        while ((tm = tildePattern.exec(source)) !== null) {
          addField(tm[1].toUpperCase(), tm[2].toUpperCase());
        }

        // ── Pattern 4: SELECT [SINGLE] fields FROM table [WHERE ...]. ──
        const selectPattern = /\bSELECT\s+(?:SINGLE\s+|DISTINCT\s+)?([\s\S]*?)\bFROM\s+([A-Z][A-Z0-9_\/]{2,30})\b([\s\S]*?)\./gi;
        let sm: RegExpExecArray | null;
        while ((sm = selectPattern.exec(source)) !== null) {
          const [, selectList, tableName, rest] = sm;
          const t = tableName.toUpperCase();
          if (skipTable(t)) continue;

          // Felder aus SELECT-Liste (nicht *, nicht ~-prefixed — die fängt Pattern 3 ab)
          if (selectList.trim() !== '*') {
            const tokens = selectList.match(/\b([A-Z_][A-Z0-9_]*)\b/gi) ?? [];
            for (const tok of tokens) {
              const u = tok.toUpperCase();
              if (!SQL_KW.has(u)) addField(t, u);
            }
          }

          // Felder aus WHERE-Klausel (Feld vor Vergleichsoperator)
          const whereMatch = rest.match(/\bWHERE\b([\s\S]*)/i);
          if (whereMatch) {
            for (const fm of whereMatch[1].matchAll(/\b([A-Z_][A-Z0-9_]*)\s*(?:=|<>|>=|<=|>|<|\bIN\b|\bLIKE\b|\bBETWEEN\b|\bIS\b)/gi)) {
              const u = fm[1].toUpperCase();
              if (!SQL_KW.has(u)) addField(t, u);
            }
          }
        }

        if (tableFieldMap.size === 0) {
          return ok("✅ No DDIC table field references found. No validation needed.");
        }

        const tableNames = [...tableFieldMap.keys()];
        const results: string[] = [];
        const errors: string[] = [];
        let validCount = 0;
        let errorCount = 0;

        await Promise.all(tableNames.map(async (tableName) => {
          try {
            const ddic = await client.ddicElement(tableName);
            // Felder aus children extrahieren
            const knownFields = new Set(
              (ddic.children ?? []).map((c: { name: string }) => c.name.toUpperCase())
            );
            const referencedFields = tableFieldMap.get(tableName)!;

            for (const field of referencedFields) {
              if (knownFields.has(field)) {
                validCount++;
              } else {
                errorCount++;
                // Ähnliche Felder suchen (enthält Feldname oder Feldname enthält similar)
                const similar = [...knownFields].filter(k =>
                  k.includes(field) || field.includes(k) ||
                  (k.length > 3 && field.length > 3 && (k.startsWith(field.substring(0, 4)) || field.startsWith(k.substring(0, 4))))
                ).slice(0, 5);
                const hint = similar.length > 0 ? ` → Similar fields: ${similar.join(', ')}` : ` (table has ${knownFields.size} fields)`;
                errors.push(`  ❌ ${tableName}-${field}: Field not found${hint}`);
              }
            }

            results.push(`  ✅ ${tableName}: ${referencedFields.size} referenced field(s) checked`);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // Not treated as error if table is not resolvable (could be a custom type alias)
            results.push(`  ⚠️  ${tableName}: DDIC not resolvable — ${msg.substring(0, 80)}`);
          }
        }));

        const summary = [
          `🔍 DDIC field validation for ${tableNames.length} table(s)/structure(s):`,
          ...results.sort(),
          "",
        ];

        if (errorCount > 0) {
          return err([
            ...summary,
            `❌ ${errorCount} invalid field reference(s) found:`,
            ...errors.sort(),
            "",
            "⚠️ These fields do not exist in the DDIC — fix the field names before calling write_abap_source!",
            "💡 Tip: Use get_ddic_element with the table name to see all available fields.",
          ].join("\n"));
        }

        return ok([
          ...summary,
          `✅ All ${validCount} field reference(s) are valid.`,
        ].join("\n"));
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
          if (!dump) return err(`Dump '${p.dumpId}' not found.`);
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
          ? `Transport '${p.transportId}': ${objects.length} object(s)\n\n${JSON.stringify(objects, null, 2)}`
          : `Transport '${p.transportId}':\n\n${xml}`);
      }

      // ── get_abapgit_repos ───────────────────────────────────────────────
      case "get_abapgit_repos": {
        const res = await client.gitRepos();
        const repos = Array.isArray(res) ? res : (res ? [res] : []);
        return ok(repos.length === 0
          ? "No abapGit repositories configured."
          : `${repos.length} repository/repositories:\n\n${JSON.stringify(repos, null, 2)}`);
      }

      // ── abapgit_pull ────────────────────────────────────────────────────
      case "abapgit_pull": {
        assertWriteEnabled("abapGit pull");
        const p = S_GitPull.parse(args);
        const res = await client.gitPullRepo(p.repoId, undefined, p.transport || undefined);
        return ok(`✅ abapGit pull executed\n${JSON.stringify(res, null, 2)}`);
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
            warning = "⚠️  WARNING: This appears to be a production system! SELECT queries can cause performance issues.\n\n";
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
          ? "No revisions found."
          : `${res.length} revision(s):\n\n${JSON.stringify(res, null, 2)}`);
      }

      // ── create_transport ─────────────────────────────────────────────────
      case "create_transport": {
        assertWriteEnabled();
        const p = S_CreateTransport.parse(args);
        const transportNumber = await client.createTransport(
          p.objectUrl, p.description, p.devClass, p.transportLayer
        );
        return ok(`✅ Transport '${transportNumber}' created`);
      }

      // ── get_fix_proposals ────────────────────────────────────────────────
      case "get_fix_proposals": {
        const p = S_FixProposals.parse(args);
        const proposals = await client.fixProposals(p.objectUrl, p.source, p.line, p.column);
        if (proposals.length === 0) return ok("No fix proposals available.");
        return ok(`${proposals.length} fix proposal(s):\n\n${JSON.stringify(proposals, null, 2)}`);
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
        if (res.length === 0) return ok("No inactive objects.");
        return ok(`${res.length} inactive object(s):\n\n${JSON.stringify(res, null, 2)}`);
      }

      // ── get_table_contents ───────────────────────────────────────────────
      case "get_table_contents": {
        const p = S_GetTableContents.parse(args);
        const res = await client.tableContents(p.tableName, p.maxRows ?? 100);
        return ok(JSON.stringify(res, null, 2));
      }

      // ── execute_abap_snippet ────────────────────────────────────────────
      case "execute_abap_snippet": {
        assertWriteEnabled("Code execution");
        if (!cfg.allowExecute)
          throw new McpError(ErrorCode.InvalidRequest,
            "Code execution is disabled. Set ALLOW_EXECUTE=true in .env (in addition to ALLOW_WRITE=true). ⚠️ Only enable on DEV systems!");
        const p = S_ExecuteSnippet.parse(args);

        // Statische Sicherheitsprüfung — verbotene Anweisungen blockieren
        const FORBIDDEN = [
          /\bCOMMIT\s+WORK\b/i,
          /\bROLLBACK\s+WORK\b/i,
          /\bCALL\s+FUNCTION\b.*\bIN\s+UPDATE\s+TASK\b/is,
          /\bINSERT\s+(?!INTO\s+@)/i,
          /\bDELETE\s+FROM\b/i,
          /\bUPDATE\s+(?!@)/i,
          /\bMODIFY\s+(?!@|\s*SCREEN)/i,
          /\bBAPI_TRANSACTION_COMMIT\b/i,
        ];
        const forbidden = FORBIDDEN.find(r => r.test(p.source));
        if (forbidden) {
          return err(
            `❌ Forbidden statement detected (${forbidden.source.substring(0, 40)}...). ` +
            "execute_abap_snippet only allows read-only operations. " +
            "For write operations: use write_abap_source."
          );
        }

        // Sicherstellen dass Code ausführbar ist (beginnt mit REPORT/PROGRAM)
        const trimmed = p.source.trim();
        const snippetSource = /^(REPORT|PROGRAM)\s/i.test(trimmed)
          ? trimmed
          : `REPORT zz_mcp_snippet.\n${trimmed}`;

        // Zufälliger Name um Kollisionen bei parallelen Aufrufen zu vermeiden
        const snippetName = `ZZ_MCP_${Date.now().toString(36).toUpperCase()}`;
        let programUrl: string | undefined;

        return await withWriteLock(() => withStatefulSession(client, async () => {
          try {
            // 1. Temporäres Programm anlegen
            await client.createObject(
              "PROG/P", snippetName, "$TMP", "MCP Temp Snippet",
              "/sap/bc/adt/packages/%24TMP", undefined, undefined
            );
            programUrl = `/sap/bc/adt/programs/programs/${snippetName.toLowerCase()}`;

            // 2. Quellcode schreiben (lock → write → unlock)
            // Direkter Lock statt lockWithRetry — withStatefulSession verwaltet die Session bereits
            const lock = await client.lock(programUrl);
            try {
              await client.setObjectSource(
                `${programUrl}/source/main`,
                snippetSource,
                lock.LOCK_HANDLE,
                undefined
              );
            } finally {
              await client.unLock(programUrl, lock.LOCK_HANDLE);
            }

            // 3. Syntaxcheck vor Ausführung
            const syntaxResult = await client.syntaxCheck(programUrl, programUrl, snippetSource);
            const syntaxErrors = (Array.isArray(syntaxResult) ? syntaxResult : [])
              .filter((m: any) => ["E", "A"].includes(m.severity));
            if (syntaxErrors.length > 0) {
              const msgs = syntaxErrors.map((e: any) =>
                `  Line ${e.line ?? "?"}: ${e.text}`
              );
              return err(`❌ Syntax error(s) — code not executed:\n${msgs.join("\n")}`);
            }

            // 4. Aktivieren (muss aktiviert sein um ausführbar zu sein)
            await client.activate(snippetName, programUrl);

            // 5. Programm ausführen
            const runResp = await client.httpClient.request(
              `${programUrl}/runs`, {
                method: "POST",
                headers: { "Content-Type": "application/xml" },
                body: `<?xml version="1.0" encoding="utf-8"?>
<run:abapProgramRun xmlns:run="http://www.sap.com/adt/programs/runs"
  run:logicalSystem=""
  run:noData="false"/>`,
              }
            );

            const output = typeof runResp.body === "string"
              ? runResp.body
              : JSON.stringify(runResp.body, null, 2);

            return ok(`✅ Execution successful\n\n${output || "(no output — WRITE statements present?)"}`);

          } finally {
            // 6. Temporäres Programm immer löschen — auch bei Fehler
            if (programUrl) {
              try {
                const delLock = await client.lock(programUrl);
                await client.deleteObject(programUrl, delLock.LOCK_HANDLE, undefined);
              } catch (delErr) {
                console.error(
                  `⚠️ Temporary program ${snippetName} could not be deleted:`,
                  delErr instanceof Error ? delErr.message : String(delErr)
                );
              }
            }
          }
        }));
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
        let objectType = "Unknown";
        let objectPackage = "";
        let objectName = baseUrl.split("/").filter(Boolean).pop() ?? "";

        try {
          structure = await client.objectStructure(baseUrl);
          objectType = (structure as any)?.["adtcore:type"] ?? (structure as any)?.objectStructure?.["adtcore:type"] ?? "Unknown";
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
              return { name: fmName, info: "(no info available)" };
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
                    if (methods.length > 0) methodList = ` | Methods: ${methods.join(", ")}`;
                  } catch { /* ignore structure read failures */ }
                  return { name: clsName, info: `${type} — ${desc}${methodList}` };
                }
              } catch { /* ignore */ }
              return { name: clsName, info: "(no info available)" };
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
              allSourceTexts[i] = allSourceTexts[i].slice(0, charBudget) + "\n... (truncated)";
              allSourceTexts.splice(i + 1);
              break;
            }
          }
          sections.push(`\n⚠️ Source code limited to ${MAX_ANALYZE_CHARS.toLocaleString()} characters (total: ${combinedLength.toLocaleString()}). Use read_abap_source for specific includes.`);
        }

        // 6. Build structured report
        sections.push(`══ CONTEXT ANALYSIS: ${objectName.toUpperCase()} ══`);

        // Program structure
        sections.push(`\n📋 PROGRAM STRUCTURE`);
        sections.push(`  Type: ${objectType}`);
        if (objectPackage) sections.push(`  Package: ${objectPackage}`);
        sections.push(`  Includes: ${includeCount}${includesList.length > 0 ? ` (${includesList.map(i => i.type).join(", ")})` : ""}`);
        if (classMethods.length > 0) sections.push(`  Methods: ${classMethods.join(", ")}`);
        if (classAttributes.length > 0) sections.push(`  Attributes: ${classAttributes.join(", ")}`);

        // Full source code
        sections.push(`\n📄 SOURCE CODE (Main + Includes)`);
        sections.push(`── MAIN (${baseUrl}) ──`);
        sections.push(mainText);
        for (const inc of includesList) {
          if (inc.source) {
            sections.push(`── ${inc.type.toUpperCase()} (${inc.uri}) ──`);
            sections.push(inc.source);
          }
        }

        // Referenced objects
        sections.push(`\n🔗 REFERENCED OBJECTS`);
        if (referencedFMs.size > 0) {
          sections.push(`  Function modules:`);
          for (const fm of referencedFMs) {
            const info = fmInfos.find(f => f.name === fm);
            sections.push(`    - ${fm}${info ? ` (${info.info})` : ""}`);
          }
        }
        if (referencedClasses.size > 0) {
          sections.push(`  Classes/Interfaces:`);
          for (const cls of referencedClasses) {
            const info = classInfos.find(c => c.name === cls);
            sections.push(`    - ${cls}${info ? ` (${info.info})` : ""}`);
          }
        }
        if (staticCalls.size > 0) {
          sections.push(`  Static calls: ${Array.from(staticCalls).join(", ")}`);
        }
        if (referencedFMs.size === 0 && referencedClasses.size === 0) {
          sections.push(`  (no external references detected)`);
        }

        // Summary
        sections.push(`\n⚡ SUMMARY`);
        sections.push(`  - ${includeCount} include(s), ${referencedFMs.size} FM(s), ${referencedClasses.size} class(es)/interface(s) referenced`);
        if (includesList.length > 0) {
          const mainInclude = includesList.find(i => i.source && i.source.length > mainText.length);
          if (mainInclude) {
            sections.push(`  - Largest code in: ${mainInclude.type} (${mainInclude.uri})`);
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
          return err(`Documentation for '${p.keyword}' not found (${result.content}).\nAttempted URL: ${result.url}`);
        }
        return ok(`${result.content}\n\n---\nQuelle: ${result.url}`);
      }

      // ── search_clean_abap ───────────────────────────────────────────────
      case "search_clean_abap": {
        const p = S_SearchCleanAbap.parse(args);
        const files = await loadCleanAbapFiles();
        const source = files.size === 1 && fs.existsSync(CLEAN_ABAP_LOCAL_DIR)
          ? "local"
          : fs.existsSync(CLEAN_ABAP_LOCAL_DIR) ? "local" : "GitHub";

        // Alle Dateien in Abschnitte zerlegen und gemeinsam durchsuchen
        const allSections: Array<{ heading: string; content: string; file: string }> = [];
        for (const [fileName, content] of files) {
          for (const s of parseMarkdownSections(content)) {
            allSections.push({ ...s, file: fileName });
          }
        }

        const terms = p.query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
        const scored = allSections
          .map(s => {
            const haystack = (s.heading + "\n" + s.content).toLowerCase();
            const score = terms.reduce((acc, t) => acc + (haystack.split(t).length - 1), 0);
            const excerpt = s.content.split("\n").slice(0, 80).join("\n").trim();
            return { heading: s.heading, file: s.file, excerpt, score };
          })
          .filter(r => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, p.maxResults ?? 2);

        if (scored.length === 0) {
          const topics = [...new Set(allSections.map(s => s.heading))].slice(0, 20).join(", ");
          return err(
            `No results for '${p.query}' in Clean ABAP Guide (${files.size} file(s) searched).\n` +
            `Available topics (selection): ${topics}`
          );
        }

        const output = scored.map(r =>
          `## ${r.heading}  _(${r.file})_\n\n${r.excerpt}`
        ).join("\n\n---\n\n");

        return ok(
          `# Clean ABAP Guide — "${p.query}" (source: ${source}, ${files.size} file(s))\n\n${output}\n\n` +
          `---\n📖 ${CLEAN_ABAP_LOCAL_DIR}`
        );
      }

      // ── review_clean_abap ──────────────────────────────────────────────
      case "review_clean_abap": {
        const p = S_ReviewCleanAbap.parse(args);
        const maxFindings = p.maxFindings ?? 10;
        const sourceLines = p.source.split("\n");
        const fullSource = p.source;

        // Collect findings: deduplicate by rule.id, track first occurrence + count
        const findingsMap = new Map<string, {
          rule: CleanAbapRule;
          line: number;
          lineText: string;
          count: number;
        }>();

        for (const rule of CLEAN_ABAP_RULES) {
          if (rule.multiline) {
            // Cross-line rules: scan full source
            const match = rule.pattern.exec(fullSource);
            if (match) {
              const lineNum = fullSource.substring(0, match.index).split("\n").length;
              const lineText = sourceLines[lineNum - 1] || "";
              // Count all matches
              let count = 0;
              const globalPattern = new RegExp(rule.pattern.source, rule.pattern.flags + (rule.pattern.flags.includes("g") ? "" : "g"));
              let m;
              while ((m = globalPattern.exec(fullSource)) !== null) {
                count++;
                if (m.index === globalPattern.lastIndex) globalPattern.lastIndex++;
              }
              findingsMap.set(rule.id, { rule, line: lineNum, lineText, count: Math.max(count, 1) });
            }
          } else {
            // Per-line rules
            for (let i = 0; i < sourceLines.length; i++) {
              if (rule.pattern.test(sourceLines[i])) {
                if (!findingsMap.has(rule.id)) {
                  findingsMap.set(rule.id, { rule, line: i + 1, lineText: sourceLines[i], count: 1 });
                } else {
                  findingsMap.get(rule.id)!.count++;
                }
              }
            }
          }
        }

        // Sort by line number, apply cap
        const findings = [...findingsMap.values()]
          .sort((a, b) => a.line - b.line)
          .slice(0, maxFindings);

        if (findings.length === 0) {
          return ok(
            `✅ No Clean ABAP anti-patterns detected (${CLEAN_ABAP_RULES.length} rules checked).\n\n` +
            `📖 ${CLEAN_ABAP_LOCAL_DIR}`
          );
        }

        // Load guidelines once
        const files = await loadCleanAbapFiles();
        const allSections: Array<{ heading: string; content: string }> = [];
        for (const [, content] of files) {
          for (const s of parseMarkdownSections(content)) {
            allSections.push(s);
          }
        }

        // Build output per finding
        const outputParts: string[] = [];
        for (const f of findings) {
          const truncLine = f.lineText.trim().length > 120
            ? f.lineText.trim().substring(0, 120) + "…"
            : f.lineText.trim();
          const countInfo = f.count > 1 ? ` (${f.count}x in source)` : "";

          let guidelinePart = "";
          const guideResults = searchCleanAbapSections(allSections, f.rule.guidelineQuery, 1);
          if (guideResults.length > 0) {
            const excerpt = guideResults[0].excerpt.split("\n").slice(0, 15).join("\n").trim();
            guidelinePart = `\n→ Clean ABAP § **${guideResults[0].heading}**\n\`\`\`\n${excerpt}\n\`\`\``;
          }

          outputParts.push(
            `## [${f.rule.category}] ${f.rule.id} — line ${f.line}${countInfo}\n` +
            `❌ ${f.rule.message}\n` +
            `   \`${truncLine}\`` +
            guidelinePart
          );
        }

        const totalAntiPatterns = [...findingsMap.values()].reduce((sum, f) => sum + f.count, 0);
        return ok(
          `# Clean ABAP Review — ${findings.length} finding(s), ${totalAntiPatterns} occurrence(s)\n\n` +
          outputParts.join("\n\n---\n\n") +
          `\n\n---\n${CLEAN_ABAP_RULES.length} rules checked | 📖 ${CLEAN_ABAP_LOCAL_DIR}`
        );
      }

      // ── search_abap_syntax ──────────────────────────────────────────────
      case "search_abap_syntax": {
        const p = S_SearchAbapSyntax.parse(args);
        const version = p.version ?? cfg.sapAbapVersion;
        const query = p.query.trim();

        // Bekannte Compound-Keywords zuerst prüfen (Reihenfolge: länger vor kürzer)
        const COMPOUND_KEYWORDS: [RegExp, string][] = [
          [/\bREAD\s+TABLE\b/i,          "read_table"],
          [/\bLOOP\s+AT\b/i,             "loop_at"],
          [/\bINSERT\s+LINES\b/i,        "insert_lines"],
          [/\bDELETE\s+ADJACENT\b/i,     "delete_adjacent_duplicates"],
          [/\bSORT\b/i,                  "sort"],
          [/\bCOLLECT\b/i,               "collect"],
          [/\bMODIFY\b/i,               "modify"],
          [/\bAPPEND\b/i,               "append"],
          [/\bCONCAT\w*\b/i,            "concatenate"],
          [/\bSELECT\b/i,               "select"],
          [/\bUPDATE\b/i,               "update"],
          [/\bINSERT\b/i,               "insert"],
          [/\bDELETE\b/i,               "delete"],
          [/\bOPEN\s+CURSOR\b/i,        "open_cursor"],
          [/\bFETCH\s+NEXT\b/i,         "fetch_next_cursor"],
          [/\bCALL\s+FUNCTION\b/i,       "call_function"],
          [/\bCALL\s+METHOD\b/i,         "call_method"],
          [/\bRAISE\s+EXCEPTION\b/i,     "raise_exception"],
          [/\bFIELD-SYMBOL\b/i,          "field-symbols"],
          [/\bASSIGN\b/i,               "assign"],
          [/\bIF\b/i,                   "if"],
          [/\bCASE\b/i,                 "case"],
          [/\bDO\b/i,                   "do"],
          [/\bWHILE\b/i,               "while"],
          [/\bFORM\b/i,                 "form"],
          [/\bMETHOD\b/i,              "method"],
          [/\bCLASS\b/i,               "class"],
          [/\bINTERFACE\b/i,           "interface"],
          [/\bTRY\b/i,                 "try"],
          [/\bRAISE\b/i,               "raise"],
          [/\bWRITE\b/i,               "write"],
          [/\bMESSAGE\b/i,             "message"],
        ];

        let keywordSlug: string | null = null;
        for (const [pattern, slug] of COMPOUND_KEYWORDS) {
          if (pattern.test(query)) { keywordSlug = slug; break; }
        }

        // Fallback: erstes Wort der Anfrage als Keyword
        if (!keywordSlug) {
          keywordSlug = query.split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9_]/g, "");
        }

        // URL-Varianten ausprobieren
        const v = version === "latest" ? "latest" : version;
        const base = `https://help.sap.com/doc/abapdocu_${v}_index_htm/${v}/en-US/`;
        const urlVariants = [
          `${base}abap${keywordSlug}.htm`,
          `${base}abap${keywordSlug.replace(/_/g, "")}.htm`,
          `${base}abap${keywordSlug}_clause.htm`,
          `${base}abap${keywordSlug}_clauses.htm`,
        ];

        let result: { success: boolean; content: string; url: string } | null = null;
        for (const url of urlVariants) {
          const r = await fetchSapDocumentation(url);
          if (r.success) { result = r; break; }
        }

        if (!result || !result.success) {
          return err(
            `No documentation found for '${query}'.\n` +
            `Tip: Try get_abap_keyword_doc with the exact keyword (e.g. "${keywordSlug.replace(/_/g, " ").toUpperCase()}").\n` +
            `Attempted URLs:\n${urlVariants.join("\n")}`
          );
        }

        // Relevanten Abschnitt herausfiltern: suche nach query-Begriffen im Content
        const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
        const lines = result.content.split("\n");
        let bestSection = "";

        // Finde den Abschnitt mit den meisten Treffern der Suchbegriffe
        let bestScore = -1;
        let bestStart = 0;
        const WINDOW = 60;
        for (let i = 0; i < lines.length; i++) {
          const window = lines.slice(i, i + WINDOW).join("\n").toLowerCase();
          const score = queryTerms.reduce((s, t) => s + (window.split(t).length - 1), 0);
          if (score > bestScore) { bestScore = score; bestStart = i; }
        }

        if (bestScore > 0) {
          // Etwas vor dem Treffer beginnen (Kontext)
          const start = Math.max(0, bestStart - 5);
          bestSection = lines.slice(start, start + WINDOW + 10).join("\n").trim();
        } else {
          // Kein spezifischer Treffer → ersten Teil der Doku zurückgeben
          bestSection = lines.slice(0, 80).join("\n").trim();
        }

        return ok(
          `# ABAP Syntax: ${query}\n\n${bestSection}\n\n` +
          `---\n📖 Vollständige Dokumentation: ${result.url}`
        );
      }

      // ── get_abap_class_doc ─────────────────────────────────────────────
      case "get_abap_class_doc": {
        const p = S_GetAbapClassDoc.parse(args);
        const version = p.version ?? cfg.sapAbapVersion;
        const url = buildClassUrl(p.className, version);
        const result = await fetchSapDocumentation(url);
        if (!result.success) {
          return err(`Documentation for '${p.className}' not found (${result.content}).\nAttempted URL: ${result.url}`);
        }
        return ok(`${result.content}\n\n---\nQuelle: ${result.url}`);
      }

      // ── get_module_best_practices ──────────────────────────────────────
      case "get_module_best_practices": {
        const p = S_GetModuleBestPractices.parse(args);
        const key = p.module.toUpperCase();
        const practices = MODULE_BEST_PRACTICES[key];
        if (!practices) {
          return err(`No best practices available for module '${p.module}'. Available modules: ${Object.keys(MODULE_BEST_PRACTICES).join(", ")}`);
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
            return err(`Unknown category '${p.category}'. Available: ${Object.keys(TOOL_CATEGORIES).join(", ")}`);
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
            `Available categories:\n\n${lines.join("\n")}\n\n` +
            `Call: find_tools(category="CATEGORY") or find_tools(query="search term")`
          );
        }

        if (matched.length === 0) {
          return ok("No matching tools found.");
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
        const action = p.enable ? "enabled" : "disabled";
        return ok(
          `${matched.length} tool(s) found${newlyEnabled > 0 ? `, ${newlyEnabled} ${action}` : ""}:\n\n${desc}`
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
            `Tool '${name}' is available but not yet enabled. ` +
            `Please call first: find_tools(${cat ? `category="${cat[0]}"` : `query="${name}"`})`
          );
        }
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    }
  } catch (e) {
    if (e instanceof McpError) throw e;
    if (isAdtError(e)) {
      const parts: string[] = [e.message];
      if (e.properties.conflictText) parts.push(`Conflict: ${e.properties.conflictText}`);
      if (e.properties.ideUser) parts.push(`Locked by: ${e.properties.ideUser}`);
      const t100id = e.properties["T100KEY-ID"];
      const t100no = e.properties["T100KEY-NO"];
      if (t100id && t100no) parts.push(`T100: ${t100id}/${t100no}`);
      throw new McpError(ErrorCode.InternalError, `ADT error: ${parts.join(" | ")}`);
    }
    const msg = (e instanceof Error ? e.message : String(e))
      .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().substring(0, 600);
    throw new McpError(ErrorCode.InternalError, `ADT error: ${msg}`);
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
  const eIcon  = cfg.allowExecute ? "✅ aktiv" : "❌ deaktiviert";
  if (cfg.allowWrite) {
    console.error(`  Blocked : ${cfg.blockedPackages.join(", ") || "keine"}`);
    console.error(`  Execute : ${eIcon}`);
  }
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
  }
  console.error("");

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("✅ MCP Server läuft auf stdio — bereit für Verbindungen");
}

main().catch(e => { console.error("Fataler Fehler:", e); process.exit(1); });
