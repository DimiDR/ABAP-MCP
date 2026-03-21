/**
 * CONTEXT ANALYSIS tool handler: analyze_abap_context
 */

import type { ADTClient } from "abap-adt-api";
import type { ToolResult } from "../../types.js";
import { S_AnalyzeContext } from "../../schemas.js";
import { ADT_PROGRAM_INCLUDES } from "../../adt-endpoints.js";

function ok(text: string): ToolResult { return { content: [{ type: "text", text }] }; }

export async function handleAnalyzeAbapContext(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_AnalyzeContext.parse(args);
  const baseUrl = p.objectUrl.replace(/\/source\/main$/, "");
  const isDeep = (p.depth ?? "deep") === "deep";

  const mainUrl = `${baseUrl}/source/main`;
  const mainSrc = await client.getObjectSource(mainUrl);
  const mainText = typeof mainSrc === "string" ? mainSrc : JSON.stringify(mainSrc);

  const sections: string[] = [];
  let includeCount = 0;
  const allSourceTexts: string[] = [mainText];

  let structure: any = null;
  let objectType = "Unknown";
  let objectPackage = "";
  let objectName = baseUrl.split("/").filter(Boolean).pop() ?? "";

  try {
    structure = await client.objectStructure(baseUrl);
    objectType = (structure as any)?.["adtcore:type"] ?? (structure as any)?.objectStructure?.["adtcore:type"] ?? "Unknown";
    objectPackage = (structure as any)?.["adtcore:packageName"] ?? (structure as any)?.objectStructure?.["adtcore:packageName"] ?? "";
    objectName = (structure as any)?.["adtcore:name"] ?? (structure as any)?.objectStructure?.["adtcore:name"] ?? objectName;
  } catch { /* structure read failed */ }

  const includesList: Array<{ type: string; uri: string; source?: string }> = [];

  if (structure) {
    const incArray = (structure as any)?.includes ??
      (structure as any)?.objectStructure?.includes ?? [];
    for (const inc of incArray) {
      const uri = inc?.["abapsource:sourceUri"] ?? inc?.sourceUri ?? inc?.uri ?? "";
      const incType = inc?.["class:includeType"] ?? inc?.includeType ?? inc?.type ?? "unknown";
      if (uri && !uri.endsWith("/source/main")) {
        includesList.push({ type: incType, uri });
      }
    }

    const links = (structure as any)?.links ?? (structure as any)?.objectStructure?.links ?? [];
    const metaLinks = (structure as any)?.metaLinks ?? [];
    for (const link of [...links, ...metaLinks]) {
      const href = link?.href ?? "";
      const rel = link?.rel ?? "";
      if (href && href.includes("/source/") && !href.endsWith("/source/main")) {
        includesList.push({ type: rel || "related", uri: href });
      }
    }
  }

  if (includesList.length > 0) {
    const includeUriToIndex = new Map(includesList.map((inc, i) => [inc.uri, i]));
    const results = await Promise.allSettled(
      includesList.map(async (inc) => {
        const src = await client.getObjectSource(inc.uri);
        return { ...inc, source: typeof src === "string" ? src : JSON.stringify(src) };
      })
    );
    for (const result of results) {
      if (result.status === "fulfilled" && result.value.source) {
        const idx = includeUriToIndex.get(result.value.uri);
        if (idx !== undefined) includesList[idx] = result.value;
        allSourceTexts.push(result.value.source);
        includeCount++;
      }
    }
  }

  if (baseUrl.includes("/programs/programs/")) {
    const includePattern = /^\s*INCLUDE\s+(\S+?)[\s.]*$/gim;
    let match;
    const resolvedIncludes: string[] = [];
    while ((match = includePattern.exec(mainText)) !== null) {
      const inclName = match[1].toLowerCase().replace(/\.$/, "");
      if (!resolvedIncludes.includes(inclName)) resolvedIncludes.push(inclName);
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
          allSourceTexts.push(result.value.source);
          includesList.push({ type: "INCLUDE", uri: result.value.name, source: result.value.source });
          includeCount++;
        }
      }
    }
  }

  if (baseUrl.includes("/functions/groups/") && structure) {
    const fmNodes = (structure as any)?.objectStructure?.nodes ?? (structure as any)?.nodes ?? [];
    const fmUrls: Array<{ name: string; uri: string }> = [];
    const collectFMs = (nodes: any[]) => {
      for (const node of nodes) {
        const uri = node?.["adtcore:uri"] ?? node?.uri ?? "";
        const fmName = node?.["adtcore:name"] ?? node?.name ?? "";
        const type = node?.["adtcore:type"] ?? node?.type ?? "";
        if (uri && (type.startsWith("FUGR/FF") || uri.includes("/fmodule/"))) {
          fmUrls.push({ name: fmName, uri });
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
          allSourceTexts.push(result.value.source);
          includesList.push({ type: "FUNCTION MODULE", uri: result.value.name, source: result.value.source });
          includeCount++;
        }
      }
    }
  }

  const classMethods: string[] = [];
  const classAttributes: string[] = [];
  if (structure) {
    const nodes = (structure as any)?.objectStructure?.nodes ?? (structure as any)?.nodes ?? [];
    const extractMembers = (nodeList: any[]) => {
      for (const node of nodeList) {
        const type = node?.["adtcore:type"] ?? node?.type ?? "";
        const memberName = node?.["adtcore:name"] ?? node?.name ?? "";
        if (type.includes("METHOD") || type.includes("CLAS/OM")) classMethods.push(memberName);
        if (type.includes("ATTR") || type.includes("CLAS/OA")) classAttributes.push(memberName);
        if (node?.nodes) extractMembers(node.nodes);
        if (node?.children) extractMembers(node.children);
      }
    };
    extractMembers(Array.isArray(nodes) ? nodes : []);
  }

  const combinedSource = allSourceTexts.join("\n");
  const referencedFMs = new Set<string>();
  const referencedClasses = new Set<string>();
  const staticCalls = new Set<string>();

  const fmPattern = /CALL\s+FUNCTION\s+'([A-Z0-9_]+)'/gi;
  let fmMatch;
  while ((fmMatch = fmPattern.exec(combinedSource)) !== null) {
    referencedFMs.add(fmMatch[1].toUpperCase());
  }

  const createObjPattern = /CREATE\s+OBJECT\s+\S+\s+TYPE\s+([A-Z0-9_]+)/gi;
  let coMatch;
  while ((coMatch = createObjPattern.exec(combinedSource)) !== null) {
    referencedClasses.add(coMatch[1].toUpperCase());
  }
  const newPattern = /NEW\s+([A-Z][A-Z0-9_]*)\s*\(/gi;
  let newMatch;
  while ((newMatch = newPattern.exec(combinedSource)) !== null) {
    const cls = newMatch[1].toUpperCase();
    if (cls !== "LINE" && cls !== "OBJECT") referencedClasses.add(cls);
  }

  const staticPattern = /([A-Z][A-Z0-9_]*)=>([A-Z0-9_]+)/gi;
  let stMatch;
  while ((stMatch = staticPattern.exec(combinedSource)) !== null) {
    const cls = stMatch[1].toUpperCase();
    const method = stMatch[2].toUpperCase();
    referencedClasses.add(cls);
    staticCalls.add(`${cls}=>${method}`);
  }

  const typeRefPattern = /TYPE\s+REF\s+TO\s+([A-Z][A-Z0-9_]*)/gi;
  let trMatch;
  while ((trMatch = typeRefPattern.exec(combinedSource)) !== null) {
    referencedClasses.add(trMatch[1].toUpperCase());
  }

  const fmInfos: Array<{ name: string; info: string }> = [];
  const classInfos: Array<{ name: string; info: string }> = [];

  if (isDeep) {
    const fmInfoResults = await Promise.allSettled(
      Array.from(referencedFMs).map(async (fmName) => {
        try {
          const searchRes = await client.searchObject(fmName, "FUGR/FF", 1);
          const items = Array.isArray(searchRes) ? searchRes : [searchRes];
          if (items.length > 0) {
            const uri = items[0]["adtcore:uri"];
            const desc = items[0]["adtcore:description"] ?? "";
            return { name: fmName, info: `${desc} (${uri})` };
          }
        } catch { /* ignore */ }
        return { name: fmName, info: "(no info available)" };
      })
    );
    for (const r of fmInfoResults) {
      if (r.status === "fulfilled") fmInfos.push(r.value);
    }

    const classInfoResults = await Promise.allSettled(
      Array.from(referencedClasses).slice(0, 20).map(async (clsName) => {
        try {
          const searchRes = await client.searchObject(clsName, undefined, 1);
          const items = Array.isArray(searchRes) ? searchRes : [searchRes];
          if (items.length > 0) {
            const desc = items[0]["adtcore:description"] ?? "";
            const type = items[0]["adtcore:type"] ?? "";
            const uri = items[0]["adtcore:uri"] ?? "";
            let methodList = "";
            try {
              const objStruct = await client.objectStructure(uri);
              const nodes = (objStruct as any)?.objectStructure?.nodes ?? (objStruct as any)?.nodes ?? [];
              const methods: string[] = [];
              const extractMethods = (nodeList: any[]) => {
                for (const node of nodeList) {
                  const nType = node?.["adtcore:type"] ?? node?.type ?? "";
                  const nName = node?.["adtcore:name"] ?? node?.name ?? "";
                  if (nType.includes("METHOD") || nType.includes("CLAS/OM") || nType.includes("INTF/OI")) {
                    methods.push(nName);
                  }
                  if (node?.nodes) extractMethods(node.nodes);
                  if (node?.children) extractMethods(node.children);
                }
              };
              extractMethods(Array.isArray(nodes) ? nodes : []);
              if (methods.length > 0) methodList = ` | Methods: ${methods.join(", ")}`;
            } catch { /* ignore */ }
            return { name: clsName, info: `${type} — ${desc}${methodList}` };
          }
        } catch { /* ignore */ }
        return { name: clsName, info: "(no info available)" };
      })
    );
    for (const r of classInfoResults) {
      if (r.status === "fulfilled") classInfos.push(r.value);
    }
  }

  const MAX_ANALYZE_CHARS = 150_000;
  const combinedLength = allSourceTexts.reduce((sum, s) => sum + s.length, 0);
  if (combinedLength > MAX_ANALYZE_CHARS) {
    let charBudget = MAX_ANALYZE_CHARS;
    for (let i = 0; i < allSourceTexts.length; i++) {
      if (allSourceTexts[i].length <= charBudget) {
        charBudget -= allSourceTexts[i].length;
      } else {
        allSourceTexts[i] = allSourceTexts[i].slice(0, charBudget) + "\n... (truncated)";
        allSourceTexts.splice(i + 1);
        break;
      }
    }
    sections.push(`\n⚠️ Source code limited to ${MAX_ANALYZE_CHARS.toLocaleString()} characters (total: ${combinedLength.toLocaleString()}). Use read_abap_source for specific includes.`);
  }

  sections.push(`══ CONTEXT ANALYSIS: ${objectName.toUpperCase()} ══`);

  sections.push(`\n📋 PROGRAM STRUCTURE`);
  sections.push(`  Type: ${objectType}`);
  if (objectPackage) sections.push(`  Package: ${objectPackage}`);
  sections.push(`  Includes: ${includeCount}${includesList.length > 0 ? ` (${includesList.map(i => i.type).join(", ")})` : ""}`);
  if (classMethods.length > 0) sections.push(`  Methods: ${classMethods.join(", ")}`);
  if (classAttributes.length > 0) sections.push(`  Attributes: ${classAttributes.join(", ")}`);

  sections.push(`\n📄 SOURCE CODE (Main + Includes)`);
  sections.push(`── MAIN (${baseUrl}) ──`);
  sections.push(mainText);
  for (const inc of includesList) {
    if (inc.source) {
      sections.push(`── ${inc.type.toUpperCase()} (${inc.uri}) ──`);
      sections.push(inc.source);
    }
  }

  sections.push(`\n🔗 REFERENCED OBJECTS`);
  if (referencedFMs.size > 0) {
    sections.push(`  Function modules:`);
    for (const fm of referencedFMs) {
      const info = fmInfos.find(f => f.name === fm);
      sections.push(`    - ${fm}${info ? ` (${info.info})` : ""}`);
    }
  }
  if (referencedClasses.size > 0) {
    sections.push(`  Classes/Interfaces:`);
    for (const cls of referencedClasses) {
      const info = classInfos.find(c => c.name === cls);
      sections.push(`    - ${cls}${info ? ` (${info.info})` : ""}`);
    }
  }
  if (staticCalls.size > 0) {
    sections.push(`  Static calls: ${Array.from(staticCalls).join(", ")}`);
  }
  if (referencedFMs.size === 0 && referencedClasses.size === 0) {
    sections.push(`  (no external references detected)`);
  }

  sections.push(`\n⚡ SUMMARY`);
  sections.push(`  - ${includeCount} include(s), ${referencedFMs.size} FM(s), ${referencedClasses.size} class(es)/interface(s) referenced`);
  if (includesList.length > 0) {
    const mainInclude = includesList.find(i => i.source && i.source.length > mainText.length);
    if (mainInclude) {
      sections.push(`  - Largest code in: ${mainInclude.type} (${mainInclude.uri})`);
    }
  }

  return ok(sections.join("\n"));
}
