/**
 * ABAP MCP Server — ADT Client Singleton
 * Lazy-initialized single connection reused across all tool calls.
 */

import { ADTClient, createSSLConfig } from "abap-adt-api";
import type { ClientOptions } from "abap-adt-api";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { cfg } from "./config.js";
import { ADT_CORE_DISCOVERY } from "./adt-endpoints.js";

let adtClient: ADTClient | null = null;

export async function getClient(): Promise<ADTClient> {
  if (adtClient) {
    try {
      await adtClient.httpClient.request(ADT_CORE_DISCOVERY, { method: "HEAD" });
      return adtClient;
    } catch {
      adtClient = null; // Session expired → reconnect
    }
  }
  const sslConfig = cfg.allowUnauthorized ? createSSLConfig(true) : {};
  const options: ClientOptions = { keepAlive: true, ...sslConfig };
  adtClient = new ADTClient(cfg.url, cfg.user, cfg.password, cfg.client, cfg.language, options);
  try {
    await adtClient.login();
  } catch (e) {
    adtClient = null;
    throw new McpError(ErrorCode.InternalError,
      `ADT connection not available: ${e instanceof Error ? e.message : String(e)}. Check: SAP_URL reachable? VPN active? SICF /sap/bc/adt activated? Credentials correct?`);
  }
  return adtClient;
}
