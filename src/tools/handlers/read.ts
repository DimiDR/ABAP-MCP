/**
 * READ tool handlers: read_abap_source, get_object_info, where_used,
 * get_code_completion, find_definition, get_revisions, get_ddic_element,
 * get_table_contents, get_fix_proposals, get_inactive_objects
 */

import type { ADTClient } from "abap-adt-api";
import type { ToolResult } from "../../types.js";
import { S_ReadSource, S_ObjectInfo, S_WhereUsed, S_CodeCompletion, S_FindDefinition, S_GetRevisions, S_GetDdicElement, S_GetTableContents, S_FixProposals, S_GetInactiveObjects } from "../../schemas.js";
import { ADT_PROGRAM_INCLUDES } from "../../adt-endpoints.js";
import { resolveMainProgram } from "../../helpers/resolve.js";

function ok(text: string): ToolResult { return { content: [{ type: "text", text }] }; }

export async function handleReadAbapSource(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_ReadSource.parse(args);
  const baseUrl = p.objectUrl.replace(/\/source\/main$/, "");
  const mainUrl = `${baseUrl}/source/main`;
  const mainSrc = await client.getObjectSource(mainUrl);
  const mainText = typeof mainSrc === "string" ? mainSrc : JSON.stringify(mainSrc);

  if (!p.includeRelated) {
    return ok(mainText);
  }

  // includeRelated: alle zugehörigen Quellen sammeln
  const sections: string[] = [`══ MAIN SOURCE (${baseUrl}) ══\n${mainText}`];

  try {
    const structure = await client.objectStructure(baseUrl);
    const links = (structure as any)?.links ?? (structure as any)?.objectStructure?.links ?? [];
    const metaLinks = (structure as any)?.metaLinks ?? [];

    // Klassen / Interfaces: Includes
    const includes: Array<{ type: string; uri: string }> = [];
    const incArray = (structure as any)?.includes ??
      (structure as any)?.objectStructure?.includes ?? [];
    for (const inc of incArray) {
      const uri = inc?.["abapsource:sourceUri"] ?? inc?.sourceUri ?? inc?.uri ?? "";
      const incType = inc?.["class:includeType"] ?? inc?.includeType ?? inc?.type ?? "unknown";
      if (uri && !uri.endsWith("/source/main")) {
        includes.push({ type: incType, uri });
      }
    }

    for (const link of [...links, ...metaLinks]) {
      const rel = link?.rel ?? "";
      const href = link?.href ?? "";
      if (href && href.includes("/source/") && !href.endsWith("/source/main")) {
        includes.push({ type: rel || "related", uri: href });
      }
    }

    const includeResults = await Promise.allSettled(
      includes.map(async (inc) => {
        const src = await client.getObjectSource(inc.uri);
        return { type: inc.type, uri: inc.uri, source: typeof src === "string" ? src : JSON.stringify(src) };
      })
    );
    for (const result of includeResults) {
      if (result.status === "fulfilled") {
        const r = result.value;
        sections.push(`══ ${r.type.toUpperCase()} (${r.uri}) ══\n${r.source}`);
      }
    }

    // Programme: INCLUDE-Anweisungen im Quellcode auflösen
    if (baseUrl.includes("/programs/programs/")) {
      const includePattern = /^\s*INCLUDE\s+(\S+?)[\s.]*$/gim;
      let match;
      const resolvedIncludes: string[] = [];
      while ((match = includePattern.exec(mainText)) !== null) {
        const inclName = match[1].toLowerCase().replace(/\.$/, "");
        if (!resolvedIncludes.includes(inclName)) {
          resolvedIncludes.push(inclName);
        }
      }
      if (resolvedIncludes.length > 0) {
        const inclResults = await Promise.allSettled(
          resolvedIncludes.map(async (name) => {
            const inclUrl = `${ADT_PROGRAM_INCLUDES}/${name}/source/main`;
            const src = await client.getObjectSource(inclUrl);
            return { name, source: typeof src === "string" ? src : JSON.stringify(src) };
          })
        );
        for (const result of inclResults) {
          if (result.status === "fulfilled") {
            const r = result.value;
            sections.push(`══ INCLUDE ${r.name.toUpperCase()} ══\n${r.source}`);
          }
        }
      }
    }

    // Funktionsgruppen: Funktionsbausteine aus Struktur lesen
    if (baseUrl.includes("/functions/groups/")) {
      const fmNodes = (structure as any)?.objectStructure?.nodes ??
        (structure as any)?.nodes ?? [];
      const fmUrls: Array<{ name: string; uri: string }> = [];
      const collectFMs = (nodes: any[]) => {
        for (const node of nodes) {
          const uri = node?.["adtcore:uri"] ?? node?.uri ?? "";
          const name = node?.["adtcore:name"] ?? node?.name ?? "";
          const type = node?.["adtcore:type"] ?? node?.type ?? "";
          if (uri && (type.startsWith("FUGR/FF") || uri.includes("/fmodule/"))) {
            fmUrls.push({ name, uri });
          }
          if (node?.nodes) collectFMs(node.nodes);
          if (node?.children) collectFMs(node.children);
        }
      };
      collectFMs(Array.isArray(fmNodes) ? fmNodes : []);
      if (fmUrls.length > 0) {
        const fmResults = await Promise.allSettled(
          fmUrls.map(async (fm) => {
            const src = await client.getObjectSource(`${fm.uri}/source/main`);
            return { name: fm.name, source: typeof src === "string" ? src : JSON.stringify(src) };
          })
        );
        for (const result of fmResults) {
          if (result.status === "fulfilled") {
            const r = result.value;
            sections.push(`══ FUNCTION MODULE ${r.name.toUpperCase()} ══\n${r.source}`);
          }
        }
      }
    }
  } catch (e: any) {
    sections.push(`\n⚠️ Note: Some related objects could not be read: ${e?.message ?? e}`);
  }

  return ok(sections.join("\n\n"));
}

export async function handleGetObjectInfo(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_ObjectInfo.parse(args);
  const info = await client.objectStructure(p.objectUrl);
  return ok(JSON.stringify(info, null, 2));
}

export async function handleWhereUsed(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_WhereUsed.parse(args);
  const res = await client.statelessClone.usageReferences(p.objectUrl);
  const items = (Array.isArray(res) ? res : []).slice(0, p.maxResults ?? 50);
  return ok(items.length === 0
    ? "No usages found."
    : `${items.length} usage(s):\n\n${JSON.stringify(items, null, 2)}`);
}

export async function handleGetCodeCompletion(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_CodeCompletion.parse(args);
  const res = await client.codeCompletion(p.objectUrl, p.source, p.line, p.column);
  const items = Array.isArray(res) ? res : [];
  return ok(items.length === 0
    ? "No suggestions found."
    : `${items.length} suggestion(s):\n\n${JSON.stringify(items, null, 2)}`);
}

export async function handleFindDefinition(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_FindDefinition.parse(args);
  const res = await client.findDefinition(
    p.objectUrl, p.source, p.line, p.startColumn, p.endColumn,
    false, resolveMainProgram(p.mainProgram)
  );
  return ok(JSON.stringify(res, null, 2));
}

export async function handleGetRevisions(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_GetRevisions.parse(args);
  const res = await client.revisions(p.objectUrl);
  return ok(res.length === 0
    ? "No revisions found."
    : `${res.length} revision(s):\n\n${JSON.stringify(res, null, 2)}`);
}

export async function handleGetDdicElement(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_GetDdicElement.parse(args);
  const res = await client.ddicElement(p.path);
  return ok(JSON.stringify(res, null, 2));
}

export async function handleGetTableContents(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_GetTableContents.parse(args);
  const res = await client.tableContents(p.tableName, p.maxRows ?? 100);
  return ok(JSON.stringify(res, null, 2));
}

export async function handleGetFixProposals(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_FixProposals.parse(args);
  const proposals = await client.fixProposals(p.objectUrl, p.source, p.line, p.column);
  if (proposals.length === 0) return ok("No fix proposals available.");
  return ok(`${proposals.length} fix proposal(s):\n\n${JSON.stringify(proposals, null, 2)}`);
}

export async function handleGetInactiveObjects(client: ADTClient, _args: Record<string, unknown>): Promise<ToolResult> {
  const res = await client.inactiveObjects();
  if (res.length === 0) return ok("No inactive objects.");
  return ok(`${res.length} inactive object(s):\n\n${JSON.stringify(res, null, 2)}`);
}
