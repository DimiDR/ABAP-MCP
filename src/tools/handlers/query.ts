/**
 * QUERY tool handlers: run_select_query, execute_abap_snippet
 */

import type { ADTClient } from "abap-adt-api";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ToolResult } from "../../types.js";
import { S_Query, S_ExecuteSnippet } from "../../schemas.js";
import { cfg } from "../../config.js";
import { ADT_CORE_DISCOVERY, ADT_PROGRAMS, ADT_TMP_PACKAGE } from "../../adt-endpoints.js";
import { assertWriteEnabled, assertSelectOnly } from "../../safety.js";
import { withWriteLock, withStatefulSession } from "../../concurrency.js";

function ok(text: string): ToolResult { return { content: [{ type: "text", text }] }; }
function err(text: string): ToolResult { return { content: [{ type: "text", text }], isError: true }; }

export async function handleRunSelectQuery(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_Query.parse(args);
  assertSelectOnly(p.query);
  const res = await client.runQuery(p.query);
  let warning = "";
  try {
    const sysInfo = await client.httpClient.request(ADT_CORE_DISCOVERY, { method: "GET" });
    const body = typeof sysInfo.body === "string" ? sysInfo.body : "";
    if (/systemType.*?[Pp]roduction/i.test(body) || /role.*?[Pp]roduction/i.test(body)) {
      warning = "⚠️  WARNING: This appears to be a production system! SELECT queries can cause performance issues.\n\n";
    }
  } catch { /* best effort */ }
  return ok(`${warning}${JSON.stringify(res, null, 2)}`);
}

export async function handleExecuteAbapSnippet(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  assertWriteEnabled("Code execution");
  if (!cfg.allowExecute)
    throw new McpError(ErrorCode.InvalidRequest,
      "Code execution is disabled. Set ALLOW_EXECUTE=true in .env (in addition to ALLOW_WRITE=true). ⚠️ Only enable on DEV systems!");
  const p = S_ExecuteSnippet.parse(args);

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

  try {
    const disc = await client.httpClient.request(ADT_CORE_DISCOVERY, { method: "GET" });
    const body = typeof disc.body === "string" ? disc.body : "";
    if (!body.includes("programs/runs") && !body.includes("program/runs")) {
      return err(
        "❌ execute_abap_snippet is not supported on this system.\n" +
        "The ADT program execution endpoint (/runs) was not found in the system's ADT Discovery document.\n" +
        "This endpoint may not be available on all on-premise systems.\n\n" +
        "Alternatives:\n" +
        "  • search_abap_syntax — search source code for patterns\n" +
        "  • run_select_query — run SELECT queries on database tables\n" +
        "  • Use SE38/SE80 in SAP GUI for direct program execution"
      );
    }
  } catch { /* best effort */ }

  const trimmed = p.source.trim();
  const snippetSource = /^(REPORT|PROGRAM)\s/i.test(trimmed)
    ? trimmed
    : `REPORT zz_mcp_snippet.\n${trimmed}`;

  const snippetName = `ZZ_MCP_${Date.now().toString(36).toUpperCase()}`;
  let programUrl: string | undefined;

  return await withWriteLock(() => withStatefulSession(client, async () => {
    try {
      await client.createObject(
        "PROG/P", snippetName, "$TMP", "MCP Temp Snippet",
        ADT_TMP_PACKAGE, undefined, undefined
      );
      programUrl = `${ADT_PROGRAMS}/${snippetName.toLowerCase()}`;

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

      const syntaxResult = await client.syntaxCheck(programUrl, programUrl, snippetSource);
      const syntaxErrors = (Array.isArray(syntaxResult) ? syntaxResult : [])
        .filter((m: any) => ["E", "A"].includes(m.severity));
      if (syntaxErrors.length > 0) {
        const msgs = syntaxErrors.map((e: any) =>
          `  Line ${e.line ?? "?"}: ${e.text}`
        );
        return err(`❌ Syntax error(s) — code not executed:\n${msgs.join("\n")}`);
      }

      await client.activate(snippetName, programUrl);

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
