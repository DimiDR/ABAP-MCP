/**
 * DIAGNOSTICS tool handlers: get_short_dumps, get_short_dump_detail, get_traces, get_trace_detail
 */

import type { ADTClient } from "abap-adt-api";
import type { ToolResult } from "../../types.js";
import { S_GetDumps, S_GetDumpDetail, S_GetTraces, S_GetTraceDetail } from "../../schemas.js";
import { ADT_RUNTIME_DUMPS } from "../../adt-endpoints.js";

function ok(text: string): ToolResult { return { content: [{ type: "text", text }] }; }
function err(text: string): ToolResult { return { content: [{ type: "text", text }], isError: true }; }

export async function handleGetShortDumps(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_GetDumps.parse(args);
  const res = await client.dumps(p.user);
  return ok(JSON.stringify(res, null, 2));
}

export async function handleGetShortDumpDetail(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_GetDumpDetail.parse(args);
  try {
    const res = await client.httpClient.request(
      `${ADT_RUNTIME_DUMPS}/${encodeURIComponent(p.dumpId)}`, { method: "GET" }
    );
    return ok(typeof res.body === "string" ? res.body : JSON.stringify(res.body, null, 2));
  } catch {
    const feed = await client.dumps();
    const dump = feed.dumps?.find(d => d.id === p.dumpId);
    if (!dump) return err(`Dump '${p.dumpId}' not found.`);
    return ok(JSON.stringify(dump, null, 2));
  }
}

export async function handleGetTraces(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_GetTraces.parse(args);
  const res = await client.tracesList(p.user);
  return ok(JSON.stringify(res, null, 2));
}

export async function handleGetTraceDetail(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_GetTraceDetail.parse(args);
  const res = await client.tracesHitList(p.traceId, true);
  return ok(JSON.stringify(res, null, 2));
}
