/**
 * ABAP MCP Server — Zod Schemas
 * Parameter validation for all MCP tools.
 */

import { z } from "zod";

// --- SEARCH ---
export const S_Search = z.object({
  query:       z.string().describe("Name pattern, wildcards * supported, e.g. 'ZCL_*SERVICE*'"),
  maxResults:  z.number().int().min(1).max(100).default(20).optional(),
  objectType:  z.string().optional().describe(
    "ADT type, e.g. PROG/P | CLAS/OC | FUGR/F | INTF/OI | DDLS/DF | TABL/DT | DOMA/DE | DTEL/DE | MSAG/E | SICF/SC. Empty = all types."
  ),
});

export const S_SearchSourceCode = z.object({
  searchString: z.string().describe("Text to search for in ABAP source code, e.g. 'Hallo', 'READ TABLE', 'BAPI_USER_GET_DETAIL'"),
  maxResults:   z.number().int().min(1).max(200).default(50).optional()
    .describe("Max results to return (default 50, max 200)"),
});

// --- READ ---
export const S_ReadSource = z.object({
  objectUrl: z.string().describe("ADT URL, e.g. /sap/bc/adt/programs/programs/ztest"),
  includeRelated: z.boolean().default(false).optional().describe(
    "If true, all related objects are automatically read along: " +
    "class includes (definitions, implementations, macros, test classes), " +
    "program includes (INCLUDE statements resolved), function group includes. " +
    "Recommended to understand the full context of an object."
  ),
});
export const S_ObjectInfo = z.object({
  objectUrl: z.string().describe("ADT URL of the object"),
});
export const S_WhereUsed = z.object({
  objectUrl:  z.string().describe("ADT URL of the object to search"),
  maxResults: z.number().int().min(1).max(200).default(50).optional(),
});
export const S_CodeCompletion = z.object({
  objectUrl:   z.string().describe("ADT URL of the object (context for completion)"),
  source:      z.string().describe("Current source code with cursor position"),
  line:        z.number().int().min(1).describe("Cursor line (1-based)"),
  column:      z.number().int().min(0).describe("Cursor column (0-based)"),
});

// --- WRITE ---
export const S_WriteSource = z.object({
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
export const S_Activate = z.object({
  objectUrl:  z.string().describe("ADT URL of the object"),
  objectName: z.string().describe("Object name, e.g. ZTEST or ZCL_FOO"),
});
export const S_MassActivate = z.object({
  objects: z.array(z.object({
    objectUrl:  z.string().describe("ADT URL"),
    objectName: z.string().describe("Object name"),
    objectType: z.string().optional().describe("ADT type, e.g. PROG/P, PROG/I, CLAS/OC (optional, derived from URL)"),
  })).describe("List of objects to activate (max. 50)"),
});
export const S_PrettyPrint = z.object({
  source:      z.string().describe("ABAP source code to format"),
  objectUrl:   z.string().optional().describe("ADT URL (for context, optional)"),
});

// --- CREATE ---
export const S_CreateProgram = z.object({
  name:        z.string().min(1).max(30).describe("Program name, must start with Z or Y"),
  description: z.string().max(40).describe("Short description (max 40 characters)"),
  devClass:    z.string().describe("Package, e.g. ZLOCAL or $TMP"),
  transport:   z.string().optional().describe("Transport request (empty for local objects)"),
  programType: z.enum(["P", "I"]).default("P").optional().describe("P = Executable (Report), I = Include (default: P)"),
});
export const S_CreateClass = z.object({
  name:        z.string().min(1).max(30).describe("Class name, must start with ZCL_ or YCL_"),
  description: z.string().max(40).describe("Short description"),
  devClass:    z.string().describe("Package"),
  transport:   z.string().optional(),
  superClass:  z.string().optional().describe("Super class, e.g. CL_ABAP_UNIT_ASSERT"),
});
export const S_CreateInterface = z.object({
  name:        z.string().min(1).max(30).describe("Interface name, must start with ZIF_ or YIF_"),
  description: z.string().max(40).describe("Short description"),
  devClass:    z.string().describe("Package"),
  transport:   z.string().optional(),
});
export const S_CreateFunctionGroup = z.object({
  name:        z.string().min(1).max(26).describe("Function group name, must start with Z or Y"),
  description: z.string().max(40).describe("Short description"),
  devClass:    z.string().describe("Package"),
  transport:   z.string().optional(),
});
export const S_CreateCdsView = z.object({
  name:        z.string().min(1).max(30).describe("CDS name, must start with Z or Y"),
  description: z.string().max(40).describe("Short description"),
  devClass:    z.string().describe("Package"),
  transport:   z.string().optional(),
});
export const S_CreateTable = z.object({
  name:        z.string().min(1).max(16).describe("Table name, must start with Z or Y"),
  description: z.string().max(40).describe("Short description"),
  devClass:    z.string().describe("Package"),
  transport:   z.string().optional(),
});
export const S_CreateMessageClass = z.object({
  name:        z.string().min(1).max(20).describe("Message class name, must start with Z or Y"),
  description: z.string().max(40).describe("Short description"),
  devClass:    z.string().describe("Package"),
  transport:   z.string().optional(),
});

// --- DELETE ---
export const S_DeleteObject = z.object({
  objectUrl:  z.string().describe("ADT URL of the object to delete"),
  objectName: z.string().describe("Object name (for confirmation)"),
  transport:  z.string().optional().describe("Transport request"),
});

// --- TEST ---
export const S_RunTests = z.object({
  objectUrl: z.string().describe("ADT URL of the class or program"),
});
export const S_CreateTestInclude = z.object({
  classUrl: z.string().describe("ADT URL of the class, e.g. /sap/bc/adt/oo/classes/zcl_foo"),
});

// --- QUALITY ---
export const S_SyntaxCheck = z.object({
  objectUrl:   z.string().describe("ADT URL of the object"),
  source:      z.string().describe("ABAP source code"),
  mainProgram: z.string().optional().describe("Main program (for includes) — name or ADT URL"),
});
export const S_RunAtc = z.object({
  objectUrl:  z.string().describe("ADT URL of the object to check"),
  checkVariant: z.string().default("DEFAULT").optional().describe("ATC check variant (default: DEFAULT)"),
});
export const S_ValidateDdic = z.object({
  source: z.string().describe("ABAP source code to validate program logic for"),
});

// --- DIAGNOSTICS ---
export const S_GetDumps = z.object({
  maxResults: z.number().int().min(1).max(100).default(20).optional(),
  user:       z.string().optional().describe("Filter by user"),
  since:      z.string().optional().describe("Time filter ISO-8601, e.g. 2025-01-01T00:00:00Z"),
});
export const S_GetDumpDetail = z.object({
  dumpId: z.string().describe("Dump ID from get_short_dumps"),
});
export const S_GetTraces = z.object({
  maxResults: z.number().int().min(1).max(50).default(10).optional(),
  user:       z.string().optional().describe("Filter by user"),
});
export const S_GetTraceDetail = z.object({
  traceId: z.string().describe("Trace ID from get_traces"),
});

// --- TRANSPORT ---
export const S_TransportInfo = z.object({
  objectUrl: z.string().describe("ADT URL of the object"),
  devClass:  z.string().describe("Package of the object"),
});
export const S_TransportObjects = z.object({
  transportId: z.string().describe("Transport request, e.g. DEVK900123"),
});

// --- ABAPGIT ---
export const S_GitRepos = z.object({
  objectUrl: z.string().optional().describe("System connection URL (empty = active system)"),
});
export const S_GitPull = z.object({
  repoId:    z.string().describe("abapGit repository ID"),
  transport: z.string().optional().describe("Transport request for pull"),
});

// --- QUERY ---
export const S_Query = z.object({
  query: z.string().describe("SELECT statement, e.g. SELECT * FROM T001 UP TO 10 ROWS"),
});
export const S_ExecuteSnippet = z.object({
  source: z.string().describe(
    "Complete executable ABAP code. Must be a valid program — " +
    "starts with REPORT or PROGRAM, ends with a period. " +
    "Output via WRITE statements. No SELECTION-SCREEN."
  ),
  timeout: z.number().int().min(1).max(30).default(10).optional()
    .describe("Maximum runtime in seconds (default: 10, max: 30)"),
});

// --- NEW TOOLS ---
export const S_FindDefinition = z.object({
  objectUrl:   z.string().describe("ADT URL of the source object (context)"),
  source:      z.string().describe("Current source code"),
  line:        z.number().int().min(1).describe("Token line (1-based)"),
  startColumn: z.number().int().min(0).describe("Token start column (0-based)"),
  endColumn:   z.number().int().min(0).describe("Token end column (0-based)"),
  mainProgram: z.string().optional().describe("Main program (for includes)"),
});
export const S_GetRevisions = z.object({
  objectUrl: z.string().describe("ADT URL of the object"),
});
export const S_CreateTransport = z.object({
  objectUrl:      z.string().describe("ADT URL of the object"),
  description:    z.string().max(60).describe("Transport description text"),
  devClass:       z.string().describe("Package"),
  transportLayer: z.string().optional().describe("Transport layer (optional)"),
});
export const S_FixProposals = z.object({
  objectUrl:   z.string().describe("ADT URL of the object"),
  source:      z.string().describe("Current source code"),
  line:        z.number().int().min(1).describe("Error line (1-based)"),
  column:      z.number().int().min(0).describe("Error column (0-based)"),
});
export const S_GetDdicElement = z.object({
  path: z.string().describe("DDIC path, e.g. table name or CDS view name"),
});
export const S_GetInactiveObjects = z.object({});
export const S_GetTableContents = z.object({
  tableName: z.string().describe("Name of the DDIC table"),
  maxRows:   z.number().int().min(1).max(1000).default(100).optional().describe("Max. number of rows (default: 100)"),
});

// --- CONTEXT ANALYSIS ---
export const S_AnalyzeContext = z.object({
  objectUrl: z.string().describe("ADT URL of the main object"),
  depth: z.enum(["shallow", "deep"]).default("deep").optional()
    .describe("shallow = main source + direct includes only; deep = recursively all references"),
});

// --- DOCUMENTATION ---
export const S_GetAbapKeywordDoc = z.object({
  keyword: z.string().describe("ABAP keyword (e.g. SELECT, LOOP, READ TABLE, MODIFY)"),
  version: z.string().optional().describe("ABAP version (e.g. 'latest', '758', '754'). Default: cfg.sapAbapVersion"),
});
export const S_GetAbapClassDoc = z.object({
  className: z.string().describe("ABAP class name or interface (e.g. CL_SALV_TABLE, IF_AMDP_MARKER_HDB)"),
  version: z.string().optional().describe("ABAP version (e.g. 'latest', '758', '754'). Default: cfg.sapAbapVersion"),
});
export const S_GetModuleBestPractices = z.object({
  module: z.enum(["FI", "CO", "MM", "SD", "PP", "PM", "QM", "HR", "HCM", "PS", "WM", "EWM", "BASIS", "BC", "ABAP"])
    .describe("SAP module (e.g. FI, MM, SD, ABAP)"),
});
export const S_SearchCleanAbap = z.object({
  query: z.string().describe(
    "Search query in the SAP Clean ABAP Styleguide (e.g. 'naming conventions', 'error handling', 'SELECT', 'method length', 'comments'). " +
    "Returns the most relevant sections from the official github.com/SAP/styleguides Clean ABAP Guide."
  ),
  maxResults: z.number().int().min(1).max(5).optional()
    .describe("Maximum number of sections (1–5, default: 2)"),
});
export const S_ReviewCleanAbap = z.object({
  source: z.string().describe(
    "ABAP source code to review for Clean ABAP compliance. " +
    "Detects anti-patterns (Hungarian notation, obsolete statements, etc.) " +
    "and returns findings with relevant Clean ABAP guideline excerpts."
  ),
  maxFindings: z.number().int().min(1).max(50).optional()
    .describe("Maximum number of findings to report (1–50, default: 10)"),
});
export const S_SearchAbapSyntax = z.object({
  query: z.string().describe(
    "Free-text search query for ABAP syntax (e.g. 'SELECT UP TO ROWS', 'LOOP AT clause order', 'READ TABLE WITH KEY'). " +
    "The tool identifies the main keyword, loads the official SAP documentation page and returns the relevant syntax section."
  ),
  version: z.string().optional().describe("ABAP version (e.g. 'latest', '758', '754'). Default: cfg.sapAbapVersion"),
});

// --- META TOOLS ---
export const S_FindTools = z.object({
  query: z.string().optional().describe("Search pattern for tool names/descriptions"),
  category: z.string().optional().describe(
    "Category: SEARCH | READ | WRITE | CREATE | DELETE | TEST | QUALITY | DIAGNOSTICS | TRANSPORT | ABAPGIT | QUERY | DOCUMENTATION"
  ),
  enable: z.boolean().optional().default(true).describe("Enable tools (default: true)"),
});
export const S_ListTools = z.object({
  category: z.string().optional().describe(
    "Filter by category: SEARCH | READ | WRITE | CREATE | DELETE | TEST | QUALITY | DIAGNOSTICS | TRANSPORT | ABAPGIT | QUERY | DOCUMENTATION. Omit for all."
  ),
});
