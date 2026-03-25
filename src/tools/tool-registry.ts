/**
 * ABAP MCP Server — Tool Registry
 * Categories, core tools, deferred tool loading, and short descriptions.
 */

import { TOOLS } from "./tool-definitions.js";
import { S_FindTools, S_ListTools } from "../schemas.js";

export const TOOL_CATEGORIES: Record<string, string[]> = {
  SEARCH:      ["search_abap_objects", "search_source_code"],
  READ:        ["read_abap_source", "get_object_info", "where_used", "get_code_completion",
                "find_definition", "get_revisions", "get_ddic_element", "get_table_fields",
                "get_table_contents", "get_fix_proposals", "analyze_abap_context"],
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
  WEBSEARCH:   ["search_sap_web"],
  BATCH:       ["batch_read"],
};

export const CORE_TOOL_NAMES = new Set([
  "find_tools",
  "list_tools",
  "search_abap_objects",
  "search_source_code",       // full-text search across ABAP source — fundamental search capability
  "read_abap_source",
  "write_abap_source",
  "get_object_info",
  "where_used",
  "analyze_abap_context",
  "search_abap_syntax",       // mandatory in abap_develop Step 5.1
  "validate_ddic_references", // mandatory in abap_develop Step 5.3
  "batch_read",              // performance: always available for parallel reads
  "search_sap_web",          // web search for SAP Help, Community & Notes — used in abap_develop Steps 2 & 5
]);

export const enabledTools = new Set<string>();

export const FIND_TOOLS_ENTRY = {
  name: "find_tools",
  description: "Finds and enables ABAP tools by search term or category. " +
    "⚠️ Most tools are deferred — call this BEFORE using any non-core tool! " +
    "Categories: SEARCH, READ, WRITE, CREATE, DELETE, TEST, " +
    "QUALITY (syntax check, ATC, Clean ABAP review, DDIC validation), " +
    "DIAGNOSTICS (short dumps, traces), TRANSPORT, ABAPGIT, QUERY, " +
    "DOCUMENTATION (ABAP syntax help), WEBSEARCH (Google SAP web search), BATCH (parallel read operations). " +
    "Enabled tools become immediately available.",
  schema: S_FindTools,
};

export const LIST_TOOLS_ENTRY = {
  name: "list_tools",
  description:
    "Returns a compact overview of ALL 50+ available tools with short descriptions, grouped by category. " +
    "Shows which tools are currently active (core/enabled) vs. deferred. " +
    "Use this to discover the right tool for a task. Unlike find_tools, this does NOT enable tools — it only lists them.",
  schema: S_ListTools,
};

export const TOOL_SHORT_DESCRIPTIONS: Record<string, string> = {
  search_abap_objects:    "Search objects by name pattern (wildcard *)",
  search_source_code:    "Full-text search across all ABAP source code",
  read_abap_source:      "Read source code (with includeRelated for full context)",
  get_object_info:       "Read metadata/structure of an object",
  where_used:            "Find all usages of an object in the system",
  get_code_completion:   "Code completion suggestions for a cursor position",
  find_definition:       "Navigate to the definition of a token in source",
  get_revisions:         "Version history of an object (date, author, transport)",
  get_ddic_element:      "DDIC info for table/view/data element/domain",
  get_table_fields:      "Field catalog of a table (name, type, key, length, description)",
  get_table_contents:    "Read table contents directly as JSON",
  get_fix_proposals:     "Quick-fix proposals for a source position",
  analyze_abap_context:  "Deep context analysis: source + includes + references",
  write_abap_source:     "Write source & activate (lock→write→check→activate→unlock)",
  activate_abap_object:  "Activate a saved object",
  mass_activate:         "Activate multiple objects at once",
  pretty_print:          "Format source via SAP Pretty Printer",
  create_abap_program:   "Create new program (report/include)",
  create_abap_class:     "Create new class (ZCL_/YCL_)",
  create_abap_interface: "Create new interface (ZIF_/YIF_)",
  create_function_group: "Create new function group",
  create_cds_view:       "Create new CDS view (DDLS)",
  create_database_table: "Create new transparent table (TABL)",
  create_message_class:  "Create new message class (MSAG)",
  delete_abap_object:    "Permanently delete an object (⛔ irreversible)",
  run_unit_tests:        "Run ABAP Unit Tests, return results",
  create_test_include:   "Create test include (CCAU) for a class",
  run_syntax_check:      "Syntax check without saving",
  run_atc_check:         "ATC check (code quality findings)",
  validate_ddic_references: "Check field references against DDIC before writing",
  review_clean_abap:     "Static Clean ABAP compliance review",
  get_short_dumps:       "List latest short dumps (ST22)",
  get_short_dump_detail: "Details of a specific short dump",
  get_traces:            "List performance traces (SAT)",
  get_trace_detail:      "Details of a specific trace",
  get_transport_info:    "Available transports for an object/package",
  get_transport_objects:  "List objects in a transport request",
  create_transport:      "Create a new transport request",
  get_abapgit_repos:     "List abapGit repositories in the system",
  abapgit_pull:          "Pull from Git into SAP (abapGit)",
  run_select_query:      "Execute SELECT on SAP tables (read-only)",
  execute_abap_snippet:  "Run temporary ABAP code snippet (auto-deleted)",
  get_inactive_objects:   "List inactive objects of current user",
  get_abap_keyword_doc:  "ABAP keyword docs from help.sap.com",
  get_abap_class_doc:    "ABAP class/interface docs from help.sap.com",
  get_module_best_practices: "Module-specific SAP best practices (FI, MM, SD…)",
  search_clean_abap:     "Search Clean ABAP Styleguide for best practices",
  search_abap_syntax:    "Search ABAP syntax docs from help.sap.com",
  search_sap_web:        "Web search across SAP Help, Community & Notes (Google CSE)",
  batch_read:            "Execute multiple read-only tools in one parallel MCP call",
  find_tools:            "Find & enable deferred tools by category/query",
  list_tools:            "Compact overview of ALL available tools & status",
};

// Build combined tool list (TOOLS + find_tools + list_tools)
export const ALL_TOOLS = [...TOOLS, FIND_TOOLS_ENTRY, LIST_TOOLS_ENTRY];
