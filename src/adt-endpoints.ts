/**
 * ADT Endpoint Paths & URL Builders
 * ==================================
 * Central registry of all ADT REST API endpoints used by this MCP server.
 * Each endpoint has a comment indicating which MCP tool(s) use it.
 *
 * Most endpoints are called indirectly via abap-adt-api ADTClient methods.
 * Endpoints marked [DIRECT] are called via client.httpClient.request().
 */

import { cfg } from "./config.js";

// ── Core / Connection ───────────────────────────────────────────────

/** [DIRECT] Heartbeat / session check / discovery
 * Used by: getClient(), execute_abap_snippet, run_select_query */
export const ADT_CORE_DISCOVERY = "/sap/bc/adt/core/discovery";

// ── Search ──────────────────────────────────────────────────────────

/** [DIRECT] Full-text source code search
 * Used by: search_source_code */
export const ADT_TEXT_SEARCH = "/sap/bc/adt/repository/informationsystem/textsearch";

// ── Programs ────────────────────────────────────────────────────────

/** Program base path
 * Used by: create_abap_program, resolveMainProgram, execute_abap_snippet, read_abap_source (includes) */
export const ADT_PROGRAMS = "/sap/bc/adt/programs/programs";

/** Program includes path
 * Used by: read_abap_source (includeRelated), analyze_abap_context */
export const ADT_PROGRAM_INCLUDES = "/sap/bc/adt/programs/includes";

// ── Classes ─────────────────────────────────────────────────────────

/** Class base path
 * Used by: create_abap_class */
export const ADT_CLASSES = "/sap/bc/adt/oo/classes";

// ── Interfaces ──────────────────────────────────────────────────────

/** Interface base path
 * Used by: create_abap_interface */
export const ADT_INTERFACES = "/sap/bc/adt/oo/interfaces";

// ── Function Groups ─────────────────────────────────────────────────

/** Function group base path
 * Used by: create_function_group */
export const ADT_FUNCTION_GROUPS = "/sap/bc/adt/function/groups";

// ── DDIC ────────────────────────────────────────────────────────────

/** CDS view (DDLS) base path
 * Used by: create_cds_view */
export const ADT_DDIC_DDL_SOURCES = "/sap/bc/adt/ddic/ddl/sources";

/** Database table base path
 * Used by: create_database_table */
export const ADT_DDIC_TABLES = "/sap/bc/adt/ddic/tables";

// ── Packages ────────────────────────────────────────────────────────

/** Package path (parent for object creation)
 * Used by: all create_* tools */
export const ADT_PACKAGES = "/sap/bc/adt/packages";

// ── Diagnostics ─────────────────────────────────────────────────────

/** [DIRECT] Short dump detail
 * Used by: get_short_dump_detail */
export const ADT_RUNTIME_DUMPS = "/sap/bc/adt/runtime/dumps";

// ── Transport ───────────────────────────────────────────────────────

/** [DIRECT] Transport request details
 * Used by: get_transport_objects */
export const ADT_TRANSPORT_REQUESTS = "/sap/bc/adt/cts/transportrequests";

// ── $TMP Package ────────────────────────────────────────────────────

/** Encoded $TMP package URL for temporary objects
 * Used by: execute_abap_snippet */
export const ADT_TMP_PACKAGE = "/sap/bc/adt/packages/%24TMP";

// ── Documentation URLs (external, help.sap.com) ─────────────────────

/** Build help.sap.com ABAP keyword documentation URL
 * Used by: get_abap_keyword_doc, search_abap_syntax */
export function buildKeywordUrl(keyword: string, version?: string): string {
  const v = (version ?? cfg.sapAbapVersion) === "latest" ? "latest" : (version ?? cfg.sapAbapVersion);
  const kw = keyword.toLowerCase().replace(/[\s-]+/g, "");
  return `https://help.sap.com/doc/abapdocu_${v}_index_htm/${v}/en-US/abap${kw}.htm`;
}

/** Build help.sap.com ABAP class documentation URL
 * Used by: get_abap_class_doc */
export function buildClassUrl(className: string, version?: string): string {
  const v = (version ?? cfg.sapAbapVersion) === "latest" ? "latest" : (version ?? cfg.sapAbapVersion);
  const cn = className.toLowerCase().replace(/[\s]+/g, "");
  return `https://help.sap.com/doc/abapdocu_${v}_index_htm/${v}/en-US/aben${cn}.htm`;
}

// ── ADT Client Method → Endpoint Mapping (reference) ────────────────
//
// client.searchObject()       → /sap/bc/adt/repository/informationsystem/search
//   Used by: search_abap_objects
//
// client.getObjectSource()    → {objectUrl}/source/main
//   Used by: read_abap_source, analyze_abap_context, write_abap_source
//
// client.setObjectSource()    → {objectUrl}/source/main
//   Used by: write_abap_source, execute_abap_snippet
//
// client.objectStructure()    → {objectUrl}
//   Used by: get_object_info, read_abap_source, analyze_abap_context
//
// client.lock()               → {objectUrl} (POST with _action=LOCK)
//   Used by: write_abap_source, delete_abap_object, create_test_include, execute_abap_snippet
//
// client.unLock()             → {objectUrl} (POST with _action=UNLOCK)
//   Used by: write_abap_source, delete_abap_object, create_test_include, execute_abap_snippet
//
// client.activate()           → /sap/bc/adt/activation
//   Used by: write_abap_source, activate_abap_object, mass_activate, execute_abap_snippet
//
// client.syntaxCheck()        → /sap/bc/adt/checkruns
//   Used by: write_abap_source, run_syntax_check, execute_abap_snippet
//
// client.createObject()       → varies by type
//   Used by: all create_* tools, execute_abap_snippet
//
// client.deleteObject()       → {objectUrl} (DELETE)
//   Used by: delete_abap_object, execute_abap_snippet
//
// client.usageReferences()    → /sap/bc/adt/repository/informationsystem/usageReferences
//   Used by: where_used
//
// client.codeCompletion()     → /sap/bc/adt/abapsource/codecompletion
//   Used by: get_code_completion
//
// client.prettyPrinter()      → /sap/bc/adt/abapsource/prettyprinter
//   Used by: pretty_print
//
// client.unitTestRun()        → /sap/bc/adt/abapunit/testruns
//   Used by: run_unit_tests
//
// client.createTestInclude()  → {classUrl}/includes (POST)
//   Used by: create_test_include
//
// client.createAtcRun()       → /sap/bc/adt/atc/runs
//   Used by: run_atc_check
//
// client.atcWorklists()       → /sap/bc/adt/atc/worklists
//   Used by: run_atc_check
//
// client.ddicElement()        → /sap/bc/adt/ddic/elements
//   Used by: get_ddic_element, validate_ddic_references
//
// client.dumps()              → /sap/bc/adt/runtime/dumps
//   Used by: get_short_dumps, get_short_dump_detail
//
// client.tracesList()         → /sap/bc/adt/runtime/traces
//   Used by: get_traces
//
// client.tracesHitList()      → /sap/bc/adt/runtime/traces/{id}/hitlist
//   Used by: get_trace_detail
//
// client.transportInfo()      → /sap/bc/adt/cts/transportchecks
//   Used by: get_transport_info
//
// client.createTransport()    → /sap/bc/adt/cts/transports
//   Used by: create_transport
//
// client.gitRepos()           → /sap/bc/adt/abapgit/repos
//   Used by: get_abapgit_repos
//
// client.gitPullRepo()        → /sap/bc/adt/abapgit/repos/{id}/pull
//   Used by: abapgit_pull
//
// client.runQuery()           → /sap/bc/adt/datapreview
//   Used by: run_select_query
//
// client.mainPrograms()       → {objectUrl}/mainprograms
//   Used by: resolveSyntaxContext (write_abap_source, run_syntax_check)
//
// client.findDefinition()     → /sap/bc/adt/navigation/target
//   Used by: find_definition
//
// client.revisions()          → {objectUrl}/versions
//   Used by: get_revisions
//
// client.fixProposals()       → /sap/bc/adt/quickfixes
//   Used by: get_fix_proposals
//
// client.inactiveObjects()    → /sap/bc/adt/repository/informationsystem/inactiveObjects
//   Used by: get_inactive_objects
//
// client.tableContents()      → /sap/bc/adt/datapreview/ddic
//   Used by: get_table_contents
//
// client.dropSession()        → session management
//   Used by: withStatefulSession
//
// client.statelessClone       → clone with separate session
//   Used by: where_used
