/**
 * BATCH handler: batch_read
 * Executes multiple read-only tool calls in parallel via Promise.allSettled().
 * Reduces MCP round-trips for clients like Cline that execute tools sequentially.
 */

import type { ADTClient } from "abap-adt-api";
import type { ToolResult, ToolHandler } from "../../types.js";
import { S_BatchRead } from "../../schemas.js";
import { HANDLER_MAP } from "../handler-map.js";

function ok(text: string): ToolResult { return { content: [{ type: "text", text }] }; }
function err(text: string): ToolResult { return { content: [{ type: "text", text }], isError: true }; }

/** Tools that are NEVER allowed in batch_read (mutating operations) */
const BLOCKED_TOOLS = new Set([
  "write_abap_source",
  "activate_abap_object",
  "mass_activate",
  "pretty_print",
  "create_abap_program",
  "create_abap_class",
  "create_abap_interface",
  "create_function_group",
  "create_cds_view",
  "create_database_table",
  "create_message_class",
  "delete_abap_object",
  "create_test_include",
  "create_transport",
  "abapgit_pull",
  "execute_abap_snippet",
  "find_tools",
  "list_tools",
  "batch_read",
]);

export async function handleBatchRead(
  client: ADTClient,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const p = S_BatchRead.parse(args);

  // Validate all tools exist and are allowed
  for (const op of p.operations) {
    if (BLOCKED_TOOLS.has(op.tool)) {
      return err(`Tool '${op.tool}' is not allowed in batch_read — only read-only tools are permitted.`);
    }
    if (!HANDLER_MAP.has(op.tool)) {
      return err(`Unknown tool '${op.tool}'. Check tool name and ensure it is enabled (call find_tools first if needed).`);
    }
  }

  // Execute all operations in parallel
  const results = await Promise.allSettled(
    p.operations.map(async (op, index) => {
      const handler = HANDLER_MAP.get(op.tool)!;
      const result = await handler(client, (op.args ?? {}) as Record<string, unknown>);
      return { index, label: op.label ?? `${op.tool}[${index}]`, result };
    })
  );

  // Combine results
  const sections: string[] = [];
  let errorCount = 0;

  for (const settled of results) {
    if (settled.status === "fulfilled") {
      const { label, result } = settled.value;
      const text = result.content.map(c => c.text).join("\n");
      const status = result.isError ? "FEHLER" : "OK";
      if (result.isError) errorCount++;
      sections.push(`═══ ${label} [${status}] ═══\n${text}`);
    } else {
      errorCount++;
      const reason = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
      sections.push(`═══ operation [FEHLER] ═══\n${reason}`);
    }
  }

  const summary = `batch_read: ${p.operations.length} operations, ${p.operations.length - errorCount} OK, ${errorCount} errors`;
  const output = `${summary}\n\n${sections.join("\n\n")}`;

  return errorCount === p.operations.length ? err(output) : ok(output);
}
