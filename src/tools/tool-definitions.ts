/**
 * ABAP MCP Server — Tool Definitions
 * Metadata for all 44+ tools (name, description, schema).
 */

import type { ToolDef } from "../types.js";
import * as S from "../schemas.js";

export const TOOLS: ToolDef[] = [
  // ── SEARCH ─────────────────────────────────────────────────────────────
  { name: "search_abap_objects",
    description: "Search for ABAP objects by name pattern. Wildcards (*) are supported. Returns name, type, ADT URI and package. Supports 30+ object types (programs, classes, function groups, CDS, tables, domains, data elements, messages, etc.).",
    schema: S.S_Search },
  { name: "search_source_code",
    description: "Full-text search across all ABAP source code in the system. Finds objects whose source contains the given text (e.g. 'Hallo', 'BAPI_USER_GET_DETAIL', 'READ TABLE'). Returns matching object names, types and ADT URIs. Requires NW 7.31+.",
    schema: S.S_SearchSourceCode },

  // ── READ ────────────────────────────────────────────────────────────────
  { name: "read_abap_source",
    description: "Reads the source code of an ABAP object. With includeRelated=true all related objects are automatically read: class includes (definitions, implementations, macros, test classes), program includes (INCLUDE statements resolved), function groups (all function modules). Recommendation: use includeRelated=true to understand the full context before making changes.",
    schema: S.S_ReadSource },
  { name: "get_object_info",
    description: "Reads detailed metadata and structure of an object: methods, attributes, includes, enqueue info, DDIC fields, etc.",
    schema: S.S_ObjectInfo },
  { name: "where_used",
    description: "Finds all usage locations of an object in the system (programs, classes, other objects). Basis for impact analysis.",
    schema: S.S_WhereUsed },
  { name: "get_code_completion",
    description: "Fetches code completion suggestions from the SAP system for a specific cursor position. Returns system-specific suggestions from the real context (method names, attributes, parameters, etc.).",
    schema: S.S_CodeCompletion },

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
    schema: S.S_WriteSource },
  { name: "activate_abap_object",
    description: "Activates an already saved ABAP object. Useful after manual changes or for reactivation after errors. ⚠️ Requires ALLOW_WRITE=true.",
    schema: S.S_Activate },
  { name: "mass_activate",
    description: "Activates multiple ABAP objects in one step. Useful after dependent changes (e.g. interface + implementation). ⚠️ Requires ALLOW_WRITE=true.",
    schema: S.S_MassActivate },
  { name: "pretty_print",
    description: "Formats ABAP source code via the SAP Pretty Printer. Indentation and keyword capitalization are configured server-side (SE38 → Settings). Returns formatted code without saving.",
    schema: S.S_PrettyPrint },

  // ── CREATE ──────────────────────────────────────────────────────────────
  { name: "create_abap_program",
    description: "Creates a new ABAP program. programType='P' for report (default), programType='I' for include. Name must start with Z or Y. ⚠️ Requires ALLOW_WRITE=true.",
    schema: S.S_CreateProgram },
  { name: "create_abap_class",
    description: "Creates a new ABAP class. Name must start with ZCL_ or YCL_. ⚠️ Requires ALLOW_WRITE=true.",
    schema: S.S_CreateClass },
  { name: "create_abap_interface",
    description: "Creates a new ABAP interface. Name must start with ZIF_ or YIF_. ⚠️ Requires ALLOW_WRITE=true.",
    schema: S.S_CreateInterface },
  { name: "create_function_group",
    description: "Creates a new function group. Name must start with Z or Y. ⚠️ Requires ALLOW_WRITE=true.",
    schema: S.S_CreateFunctionGroup },
  { name: "create_cds_view",
    description: "Creates a new CDS view (DDLS). Name must start with Z or Y. ⚠️ Requires ALLOW_WRITE=true.",
    schema: S.S_CreateCdsView },
  { name: "create_database_table",
    description: "Creates a new transparent database table (TABL). Name must start with Z or Y. ⚠️ Requires ALLOW_WRITE=true.",
    schema: S.S_CreateTable },
  { name: "create_message_class",
    description: "Creates a new message class (MSAG). Name must start with Z or Y. ⚠️ Requires ALLOW_WRITE=true.",
    schema: S.S_CreateMessageClass },

  // ── DELETE ──────────────────────────────────────────────────────────────
  { name: "delete_abap_object",
    description: "Permanently deletes an ABAP object. ⛔ CANNOT BE UNDONE. Requires ALLOW_DELETE=true and ALLOW_WRITE=true.",
    schema: S.S_DeleteObject },

  // ── TEST ────────────────────────────────────────────────────────────────
  { name: "run_unit_tests",
    description: "Runs ABAP Unit Tests for a class or program. Returns test results with pass/fail status and error messages.",
    schema: S.S_RunTests },
  { name: "create_test_include",
    description: "Creates a test include (CCAU) for an existing class. Generates the basic structure for ABAP Unit Tests. ⚠️ Requires ALLOW_WRITE=true.",
    schema: S.S_CreateTestInclude },

  // ── QUALITY ─────────────────────────────────────────────────────────────
  { name: "run_syntax_check",
    description: "Runs an ABAP syntax check without saving. Returns errors and warnings with line numbers.",
    schema: S.S_SyntaxCheck },
  { name: "run_atc_check",
    description: "Starts an ATC check (ABAP Test Cockpit) for an object. Returns code quality findings with priority, category and description.",
    schema: S.S_RunAtc },
  { name: "validate_ddic_references",
    description:
      "Statically analyzes ABAP source code and checks all referenced table fields against DDIC metadata. " +
      "Returns a list of invalid field names. " +
      "⚡ Recommended to call before write_abap_source to avoid 'Field unknown' syntax errors. " +
      "Detects: (1) TYPE/LIKE tab-field, (2) table~field (New SQL), (3) SELECT field list FROM table, (4) WHERE clause fields.",
    schema: S.S_ValidateDdic },

  // ── DIAGNOSTICS ─────────────────────────────────────────────────────────
  { name: "get_short_dumps",
    description: "Reads the list of the latest short dumps (runtime errors) from the system. Corresponds to transaction ST22.",
    schema: S.S_GetDumps },
  { name: "get_short_dump_detail",
    description: "Reads details of a specific short dump: error text, call stack, local variables, source code position.",
    schema: S.S_GetDumpDetail },
  { name: "get_traces",
    description: "Reads the list of performance traces (SQL trace, ABAP trace). Corresponds to transaction SAT.",
    schema: S.S_GetTraces },
  { name: "get_trace_detail",
    description: "Reads details of a specific performance trace: runtime, hit count, most expensive statements.",
    schema: S.S_GetTraceDetail },

  // ── TRANSPORT ───────────────────────────────────────────────────────────
  { name: "get_transport_info",
    description: "Returns available transport requests for an object and its package.",
    schema: S.S_TransportInfo },
  { name: "get_transport_objects",
    description: "Lists all objects in a transport request. Shows what a transport contains.",
    schema: S.S_TransportObjects },

  // ── ABAPGIT ─────────────────────────────────────────────────────────────
  { name: "get_abapgit_repos",
    description: "Lists all abapGit repositories configured in the system.",
    schema: S.S_GitRepos },
  { name: "abapgit_pull",
    description: "Performs an abapGit pull for a repository (imports code from Git). ⚠️ Requires ALLOW_WRITE=true.",
    schema: S.S_GitPull },

  // ── QUERY ───────────────────────────────────────────────────────────────
  { name: "run_select_query",
    description: "Executes a SELECT statement directly against SAP tables. Returns result rows as JSON. Only read-only access is allowed.",
    schema: S.S_Query },
  { name: "execute_abap_snippet",
    description:
      "Executes a temporary ABAP code snippet live in the SAP system and returns the output. " +
      "The program is created in $TMP, executed immediately and then automatically deleted — no permanent state. " +
      "Ideal for: checking table values, testing calculations, inspecting API return values, validating debugging hypotheses. " +
      "⚠️ Requires ALLOW_WRITE=true. " +
      "⚠️ Use read-only logic only — COMMIT WORK, BAPI calls and write DB operations are forbidden. " +
      "The tool statically checks the code for forbidden statements before executing it.",
    schema: S.S_ExecuteSnippet },

  // ── NEW TOOLS ─────────────────────────────────────────────────────────────
  { name: "find_definition",
    description: "Navigates to the definition of a token (variable, method, class, etc.) in source code. Returns URI, line and column of the definition.",
    schema: S.S_FindDefinition },
  { name: "get_revisions",
    description: "Reads the version history of an ABAP object. Returns all saved revisions with date, author and transport request.",
    schema: S.S_GetRevisions },
  { name: "create_transport",
    description: "Creates a new transport request. Returns the transport number. ⚠️ Requires ALLOW_WRITE=true.",
    schema: S.S_CreateTransport },
  { name: "get_fix_proposals",
    description: "Fetches quick-fix proposals for a specific position in source code (e.g. implement missing method, declare variable).",
    schema: S.S_FixProposals },
  { name: "get_ddic_element",
    description: "Reads detailed DDIC information for a table, view, data element or domain. Returns fields, types, annotations and associations.",
    schema: S.S_GetDdicElement },
  { name: "get_inactive_objects",
    description: "Lists all inactive (not yet activated) objects of the current user.",
    schema: S.S_GetInactiveObjects },
  { name: "get_table_fields",
    description: "Returns the field catalog (columns) of a DDIC table: field name, ABAP type, description, key flag, and length. " +
      "Use this to explore table structures before writing SELECT statements or validating field references. " +
      "Works for transparent tables, views, and CDS entities.",
    schema: S.S_GetTableFields },
  { name: "get_table_contents",
    description: "Reads table contents directly from a DDIC table. Returns data as JSON.",
    schema: S.S_GetTableContents },

  // ── BATCH ─────────────────────────────────────────────────────────────
  { name: "batch_read",
    description: "Executes multiple read-only tool calls in a single MCP request — the server runs them in parallel (Promise.allSettled) " +
      "and returns all results at once. Dramatically reduces round-trip latency for clients like Cline that execute tools sequentially.\n" +
      "Each operation specifies a tool name and its arguments (same as calling the tool directly). " +
      "Only read-only tools are allowed (no write/create/delete). Max 20 operations per batch.\n" +
      "Example: batch_read({ operations: [ { tool: 'read_abap_source', args: { objectUrl: '...', includeRelated: true }, label: 'main' }, " +
      "{ tool: 'where_used', args: { objectUrl: '...' }, label: 'usages' }, " +
      "{ tool: 'get_object_info', args: { objectUrl: '...' }, label: 'info' } ] })",
    schema: S.S_BatchRead },

  // ── CONTEXT ANALYSIS ──────────────────────────────────────────────────
  { name: "analyze_abap_context",
    description: "Analyzes the complete context of an ABAP object: reads source code including all includes, detects referenced function modules, classes and interfaces via regex, retrieves their metadata and returns a structured context report. Entry point for the abap_develop workflow.",
    schema: S.S_AnalyzeContext },

  // ── DOCUMENTATION ─────────────────────────────────────────────────────
  { name: "get_abap_keyword_doc",
    description: "Fetches ABAP keyword documentation from help.sap.com (e.g. SELECT, LOOP, READ TABLE). Returns the official SAP documentation as formatted text.",
    schema: S.S_GetAbapKeywordDoc },
  { name: "get_abap_class_doc",
    description: "Fetches ABAP class/interface documentation from help.sap.com (e.g. CL_SALV_TABLE, IF_AMDP_MARKER_HDB). Returns the official SAP documentation as formatted text.",
    schema: S.S_GetAbapClassDoc },
  { name: "get_module_best_practices",
    description: "Returns module-specific SAP ABAP best practices (important tables, recommended BAPIs/classes, coding guidelines, common errors, S/4HANA migration hints). Modules: FI, CO, MM, SD, PP, PM, QM, HR, HCM, PS, WM, EWM, BASIS, BC, ABAP.",
    schema: S.S_GetModuleBestPractices },
  { name: "search_clean_abap",
    description: "Searches the official SAP Clean ABAP Styleguide (github.com/SAP/styleguides) for best practices, naming conventions, coding guidelines and anti-patterns. " +
      "Returns the most relevant sections. Call before writing new code to comply with Clean ABAP conventions.",
    schema: S.S_SearchCleanAbap },
  { name: "search_abap_syntax",
    description: "Searches the official ABAP syntax documentation from help.sap.com based on a free-text query (e.g. 'SELECT UP TO ROWS', 'LOOP AT clause order'). " +
      "Automatically identifies the main keyword, loads the documentation page and returns the relevant syntax section. " +
      "Call BEFORE writing ABAP code to ensure correct syntax.",
    schema: S.S_SearchAbapSyntax },
  { name: "review_clean_abap",
    description:
      "Reviews ABAP source code for Clean ABAP compliance. " +
      "Detects anti-patterns (Hungarian notation, MOVE/COMPUTE/CONCATENATE, FORM subroutines, " +
      "SELECT...ENDSELECT loops, sy-subrc checks, CALL METHOD) and returns findings with " +
      "relevant Clean ABAP guideline excerpts. " +
      "No SAP system connection required — pure static analysis. " +
      "Call on existing code before writing to understand current conventions.",
    schema: S.S_ReviewCleanAbap },

  // ── WEBSEARCH ──────────────────────────────────────────────────────────
  { name: "search_sap_web",
    description: "Searches SAP Help (help.sap.com), SAP Community (community.sap.com) and SAP Notes (me.sap.com) via Tavily Search API. " +
      "Returns compact results (title + URL + snippet) to minimize token usage. " +
      "Use for: error messages, SAP Notes, best practices, blog posts, KBAs, migration guides. " +
      "Requires TAVILY_API_KEY in .env.",
    schema: S.S_SearchSapWeb },
];
