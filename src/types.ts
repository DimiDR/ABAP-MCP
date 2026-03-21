/**
 * ABAP MCP Server — Shared Type Definitions
 */

import type { z } from "zod";
import type { ADTClient } from "abap-adt-api";

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
}

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export type ToolHandler = (
  client: ADTClient,
  args: Record<string, unknown>,
  extra?: any,
) => Promise<ToolResult>;
