/**
 * META tool handlers: find_tools, list_tools
 */

import type { ADTClient } from "abap-adt-api";
import type { ToolResult } from "../../types.js";
import { S_FindTools, S_ListTools } from "../../schemas.js";
import { TOOLS } from "../tool-definitions.js";
import { TOOL_CATEGORIES, CORE_TOOL_NAMES, enabledTools, TOOL_SHORT_DESCRIPTIONS } from "../tool-registry.js";
import { cfg } from "../../config.js";

function ok(text: string): ToolResult { return { content: [{ type: "text", text }] }; }
function err(text: string): ToolResult { return { content: [{ type: "text", text }], isError: true }; }

/** Callback set by server.ts to notify MCP clients of tool list changes */
export let notifyToolListChanged: (() => Promise<void>) | undefined;

export function setNotifyToolListChanged(fn: () => Promise<void>): void {
  notifyToolListChanged = fn;
}

export async function handleFindTools(_client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_FindTools.parse(args);
  let matched: typeof TOOLS = [];

  if (p.category) {
    const cat = p.category.toUpperCase();
    const toolNames = TOOL_CATEGORIES[cat];
    if (!toolNames) {
      return err(`Unknown category '${p.category}'. Available: ${Object.keys(TOOL_CATEGORIES).join(", ")}`);
    }
    matched = TOOLS.filter(t => toolNames.includes(t.name));
  } else if (p.query) {
    const q = p.query.toLowerCase();
    matched = TOOLS.filter(t =>
      t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
    );
  } else {
    const lines = Object.entries(TOOL_CATEGORIES).map(([cat, names]) =>
      `${cat} (${names.length}): ${names.join(", ")}`
    );
    return ok(
      `Available categories:\n\n${lines.join("\n")}\n\n` +
      `Call: find_tools(category="CATEGORY") or find_tools(query="search term")`
    );
  }

  if (matched.length === 0) {
    return ok("No matching tools found.");
  }

  let newlyEnabled = 0;
  for (const t of matched) {
    if (p.enable) {
      if (!enabledTools.has(t.name) && !CORE_TOOL_NAMES.has(t.name)) {
        enabledTools.add(t.name);
        newlyEnabled++;
      }
    } else {
      if (enabledTools.delete(t.name)) newlyEnabled++;
    }
  }

  if (newlyEnabled > 0 && cfg.deferTools && notifyToolListChanged) {
    await notifyToolListChanged();
  }

  const desc = matched.map(t => `• ${t.name}: ${t.description}`).join("\n");
  const action = p.enable ? "enabled" : "disabled";
  return ok(
    `${matched.length} tool(s) found${newlyEnabled > 0 ? `, ${newlyEnabled} ${action}` : ""}:\n\n${desc}`
  );
}

export async function handleListTools(_client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_ListTools.parse(args);
  const categoriesToShow = p.category
    ? { [p.category.toUpperCase()]: TOOL_CATEGORIES[p.category.toUpperCase()] }
    : TOOL_CATEGORIES;

  if (p.category && !TOOL_CATEGORIES[p.category.toUpperCase()]) {
    return err(`Unknown category '${p.category}'. Available: ${Object.keys(TOOL_CATEGORIES).join(", ")}`);
  }

  const lines: string[] = [];
  for (const [cat, names] of Object.entries(categoriesToShow)) {
    lines.push(`\n── ${cat} ──`);
    for (const n of names) {
      const isCore = CORE_TOOL_NAMES.has(n);
      const isEnabled = enabledTools.has(n);
      const status = isCore ? "core" : isEnabled ? "active" : "deferred";
      const desc = TOOL_SHORT_DESCRIPTIONS[n] ?? "";
      lines.push(`  [${status}] ${n} — ${desc}`);
    }
  }

  if (!p.category) {
    lines.push(`\n── META ──`);
    for (const n of ["find_tools", "list_tools"]) {
      const desc = TOOL_SHORT_DESCRIPTIONS[n] ?? "";
      lines.push(`  [core] ${n} — ${desc}`);
    }
  }

  const summary = p.category
    ? ""
    : `\nTotal: ${TOOLS.length} tools + 2 meta-tools. ` +
      `Core (always available): ${CORE_TOOL_NAMES.size}. ` +
      `Deferred tools need find_tools(category=...) to enable.\n`;

  return ok(summary + lines.join("\n"));
}
