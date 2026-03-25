/**
 * ABAP MCP Server — Handler Dispatch Map
 * Maps tool names to their handler functions, replacing the monolithic switch.
 */

import type { ToolHandler } from "../types.js";

// ── Handler imports ─────────────────────────────────────────────────────────
import { handleSearchAbapObjects, handleSearchSourceCode } from "./handlers/search.js";
import {
  handleReadAbapSource, handleGetObjectInfo, handleWhereUsed,
  handleGetCodeCompletion, handleFindDefinition, handleGetRevisions,
  handleGetDdicElement, handleGetTableFields, handleGetTableContents,
  handleGetFixProposals, handleGetInactiveObjects,
} from "./handlers/read.js";
import {
  handleWriteAbapSource, handleActivateAbapObject,
  handleMassActivate, handlePrettyPrint,
} from "./handlers/write.js";
import {
  handleCreateAbapProgram, handleCreateAbapClass, handleCreateAbapInterface,
  handleCreateFunctionGroup, handleCreateCdsView, handleCreateDatabaseTable,
  handleCreateMessageClass,
} from "./handlers/create.js";
import { handleDeleteAbapObject } from "./handlers/delete.js";
import { handleRunUnitTests, handleCreateTestInclude } from "./handlers/test.js";
import {
  handleRunSyntaxCheck, handleRunAtcCheck,
  handleValidateDdicReferences, handleReviewCleanAbap,
} from "./handlers/quality.js";
import {
  handleGetShortDumps, handleGetShortDumpDetail,
  handleGetTraces, handleGetTraceDetail,
} from "./handlers/diagnostics.js";
import {
  handleGetTransportInfo, handleGetTransportObjects, handleCreateTransport,
} from "./handlers/transport.js";
import { handleGetAbapgitRepos, handleAbapgitPull } from "./handlers/abapgit.js";
import { handleRunSelectQuery, handleExecuteAbapSnippet } from "./handlers/query.js";
import {
  handleGetAbapKeywordDoc, handleGetAbapClassDoc,
  handleGetModuleBestPractices, handleSearchCleanAbap, handleSearchAbapSyntax,
} from "./handlers/documentation.js";
import { handleAnalyzeAbapContext } from "./handlers/context.js";
import { handleSearchSapWeb } from "./handlers/websearch.js";
import { handleBatchRead } from "./handlers/batch.js";
import { handleFindTools, handleListTools } from "./handlers/meta.js";

// ── Dispatch map ────────────────────────────────────────────────────────────

export const HANDLER_MAP: Map<string, ToolHandler> = new Map([
  // SEARCH
  ["search_abap_objects",     handleSearchAbapObjects],
  ["search_source_code",      handleSearchSourceCode],

  // READ
  ["read_abap_source",        handleReadAbapSource],
  ["get_object_info",         handleGetObjectInfo],
  ["where_used",              handleWhereUsed],
  ["get_code_completion",     handleGetCodeCompletion],
  ["find_definition",         handleFindDefinition],
  ["get_revisions",           handleGetRevisions],
  ["get_ddic_element",        handleGetDdicElement],
  ["get_table_fields",        handleGetTableFields],
  ["get_table_contents",      handleGetTableContents],
  ["get_fix_proposals",       handleGetFixProposals],
  ["get_inactive_objects",    handleGetInactiveObjects],

  // WRITE
  ["write_abap_source",       handleWriteAbapSource],
  ["activate_abap_object",    handleActivateAbapObject],
  ["mass_activate",           handleMassActivate],
  ["pretty_print",            handlePrettyPrint],

  // CREATE
  ["create_abap_program",     handleCreateAbapProgram],
  ["create_abap_class",       handleCreateAbapClass],
  ["create_abap_interface",   handleCreateAbapInterface],
  ["create_function_group",   handleCreateFunctionGroup],
  ["create_cds_view",         handleCreateCdsView],
  ["create_database_table",   handleCreateDatabaseTable],
  ["create_message_class",    handleCreateMessageClass],

  // DELETE
  ["delete_abap_object",      handleDeleteAbapObject],

  // TEST
  ["run_unit_tests",          handleRunUnitTests],
  ["create_test_include",     handleCreateTestInclude],

  // QUALITY
  ["run_syntax_check",        handleRunSyntaxCheck],
  ["run_atc_check",           handleRunAtcCheck],
  ["validate_ddic_references", handleValidateDdicReferences],
  ["review_clean_abap",       handleReviewCleanAbap],

  // DIAGNOSTICS
  ["get_short_dumps",         handleGetShortDumps],
  ["get_short_dump_detail",   handleGetShortDumpDetail],
  ["get_traces",              handleGetTraces],
  ["get_trace_detail",        handleGetTraceDetail],

  // TRANSPORT
  ["get_transport_info",      handleGetTransportInfo],
  ["get_transport_objects",   handleGetTransportObjects],
  ["create_transport",        handleCreateTransport],

  // ABAPGIT
  ["get_abapgit_repos",       handleGetAbapgitRepos],
  ["abapgit_pull",            handleAbapgitPull],

  // QUERY
  ["run_select_query",        handleRunSelectQuery],
  ["execute_abap_snippet",    handleExecuteAbapSnippet],

  // DOCUMENTATION
  ["get_abap_keyword_doc",    handleGetAbapKeywordDoc],
  ["get_abap_class_doc",      handleGetAbapClassDoc],
  ["get_module_best_practices", handleGetModuleBestPractices],
  ["search_clean_abap",       handleSearchCleanAbap],
  ["search_abap_syntax",      handleSearchAbapSyntax],

  // CONTEXT
  ["analyze_abap_context",    handleAnalyzeAbapContext],

  // WEBSEARCH
  ["search_sap_web",          handleSearchSapWeb],

  // BATCH
  ["batch_read",              handleBatchRead],

  // META
  ["find_tools",              handleFindTools],
  ["list_tools",              handleListTools],
]);
