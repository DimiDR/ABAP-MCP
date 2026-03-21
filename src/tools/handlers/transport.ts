/**
 * TRANSPORT tool handlers: get_transport_info, get_transport_objects, create_transport
 */

import type { ADTClient } from "abap-adt-api";
import type { ToolResult } from "../../types.js";
import { S_TransportInfo, S_TransportObjects, S_CreateTransport } from "../../schemas.js";
import { ADT_TRANSPORT_REQUESTS } from "../../adt-endpoints.js";
import { assertWriteEnabled } from "../../safety.js";

function ok(text: string): ToolResult { return { content: [{ type: "text", text }] }; }

export async function handleGetTransportInfo(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_TransportInfo.parse(args);
  const res = await client.transportInfo(p.objectUrl, p.devClass);
  return ok(JSON.stringify(res, null, 2));
}

export async function handleGetTransportObjects(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_TransportObjects.parse(args);
  const tUrl = `${ADT_TRANSPORT_REQUESTS}/${encodeURIComponent(p.transportId)}`;
  const tResp = await client.httpClient.request(tUrl, { method: "GET" });
  const xml = typeof tResp.body === "string" ? tResp.body : "";
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

export async function handleCreateTransport(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  assertWriteEnabled();
  const p = S_CreateTransport.parse(args);
  const transportNumber = await client.createTransport(
    p.objectUrl, p.description, p.devClass, p.transportLayer
  );
  return ok(`✅ Transport '${transportNumber}' created`);
}
