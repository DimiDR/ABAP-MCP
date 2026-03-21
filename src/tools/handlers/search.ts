/**
 * SEARCH tool handlers: search_abap_objects, search_source_code
 */

import type { ADTClient } from "abap-adt-api";
import type { ToolResult } from "../../types.js";
import { S_Search, S_SearchSourceCode } from "../../schemas.js";
import { ADT_TEXT_SEARCH } from "../../adt-endpoints.js";

function ok(text: string): ToolResult { return { content: [{ type: "text", text }] }; }

export async function handleSearchAbapObjects(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
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

export async function handleSearchSourceCode(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_SearchSourceCode.parse(args);
  const max = p.maxResults ?? 50;
  const resp = await client.httpClient.request(
    ADT_TEXT_SEARCH,
    {
      method: "GET",
      qs: {
        searchString: p.searchString,
        searchFromIndex: 1,
        searchToIndex: max,
      },
      headers: { Accept: "application/*" },
    }
  );
  const xml = typeof resp.body === "string" ? resp.body : "";
  const results: Array<{ name: string; type: string; uri: string; description?: string }> = [];
  const refPattern = /<(?:adtcore:objectReference|adtMainObject)[^>]*?adtcore:name="([^"]*)"[^>]*?adtcore:type="([^"]*)"[^>]*?adtcore:uri="([^"]*)"(?:[^>]*?adtcore:description="([^"]*)")?/g;
  let match;
  while ((match = refPattern.exec(xml)) !== null) {
    results.push({
      name: match[1],
      type: match[2],
      uri:  match[3],
      ...(match[4] ? { description: match[4] } : {}),
    });
  }
  return ok(results.length === 0
    ? `No source code matches found for '${p.searchString}'`
    : `${results.length} object(s) contain '${p.searchString}':\n\n${JSON.stringify(results, null, 2)}`);
}
