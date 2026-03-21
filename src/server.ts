/**
 * ABAP MCP Server — MCP Server Setup & Request Handlers
 * Thin dispatcher: ListTools, ListPrompts, GetPrompt, CallTool
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { isAdtError } from "abap-adt-api";

import { cfg } from "./config.js";
import { getClient } from "./adt-client.js";
import { toJsonSchema } from "./helpers/json-schema.js";
import { getAbapDevelopPrompt } from "./prompt.js";
import { ALL_TOOLS, CORE_TOOL_NAMES, enabledTools, TOOL_CATEGORIES } from "./tools/tool-registry.js";
import { HANDLER_MAP } from "./tools/handler-map.js";
import { setNotifyToolListChanged } from "./tools/handlers/meta.js";

// ── Server instance ─────────────────────────────────────────────────────────

export const server = new Server(
  { name: "abap-mcp-server", version: "2.0.0" },
  { capabilities: { tools: { listChanged: true }, prompts: {} } }
);

// Wire up the find_tools notification callback (avoids circular dep handler→server)
setNotifyToolListChanged(() => server.sendToolListChanged());

// ── LIST TOOLS ──────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const visibleTools = cfg.deferTools
    ? ALL_TOOLS.filter(t => CORE_TOOL_NAMES.has(t.name) || enabledTools.has(t.name))
    : ALL_TOOLS;
  return {
    tools: visibleTools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: toJsonSchema(t.schema),
    })),
  };
});

// ── LIST PROMPTS ────────────────────────────────────────────────────────────

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [{
    name: "abap_develop",
    description: "Intelligent ABAP development workflow: First analyzes the complete context, applies modern ABAP principles.",
    arguments: [
      { name: "object_name", description: "Name of the ABAP object (e.g. ZRYBAK_TEST)", required: true },
      { name: "task", description: "Task (e.g. 'Add ALV grid with CL_SALV_TABLE')", required: true },
    ],
  }],
}));

// ── GET PROMPT ──────────────────────────────────────────────────────────────

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: promptArgs } = request.params;
  if (name !== "abap_develop")
    throw new McpError(ErrorCode.InvalidRequest, `Unknown prompt: ${name}`);

  const objectName = promptArgs?.object_name ?? "";
  const task = promptArgs?.task ?? "";
  return getAbapDevelopPrompt(objectName, task);
});

// ── CALL TOOL ───────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;
  const client = await getClient();

  try {
    const handler = HANDLER_MAP.get(name);
    if (handler) {
      return await handler(client, args ?? {}, extra);
    }

    // Tool exists but is deferred and not yet enabled
    const knownTool = ALL_TOOLS.find(t => t.name === name);
    if (knownTool && cfg.deferTools && !CORE_TOOL_NAMES.has(name) && !enabledTools.has(name)) {
      const cat = Object.entries(TOOL_CATEGORIES).find(([, names]) => names.includes(name));
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Tool '${name}' is available but not yet enabled. ` +
        `Please call first: find_tools(${cat ? `category="${cat[0]}"` : `query="${name}"`})`
      );
    }

    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  } catch (e) {
    if (e instanceof McpError) throw e;
    if (isAdtError(e)) {
      const parts: string[] = [e.message];
      if (e.properties.conflictText) parts.push(`Conflict: ${e.properties.conflictText}`);
      if (e.properties.ideUser) parts.push(`Locked by: ${e.properties.ideUser}`);
      const t100id = e.properties["T100KEY-ID"];
      const t100no = e.properties["T100KEY-NO"];
      if (t100id && t100no) parts.push(`T100: ${t100id}/${t100no}`);
      throw new McpError(ErrorCode.InternalError, `ADT error: ${parts.join(" | ")}`);
    }
    const msg = (e instanceof Error ? e.message : String(e))
      .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().substring(0, 600);
    throw new McpError(ErrorCode.InternalError, `ADT error: ${msg}`);
  }
});
