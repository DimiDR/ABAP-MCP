/**
 * DOCUMENTATION tool handlers: get_abap_keyword_doc, get_abap_class_doc,
 * get_module_best_practices, search_clean_abap, search_abap_syntax
 */

import * as fs from "fs";
import type { ADTClient } from "abap-adt-api";
import type { ToolResult } from "../../types.js";
import { S_GetAbapKeywordDoc, S_GetAbapClassDoc, S_GetModuleBestPractices, S_SearchCleanAbap, S_SearchAbapSyntax } from "../../schemas.js";
import { cfg } from "../../config.js";
import { buildKeywordUrl, buildClassUrl } from "../../adt-endpoints.js";
import { fetchSapDocumentation } from "../../helpers/documentation.js";
import { CLEAN_ABAP_LOCAL_DIR, loadCleanAbapFiles, parseMarkdownSections } from "../../helpers/clean-abap.js";
import { MODULE_BEST_PRACTICES } from "../../data/module-best-practices.js";

function ok(text: string): ToolResult { return { content: [{ type: "text", text }] }; }
function err(text: string): ToolResult { return { content: [{ type: "text", text }], isError: true }; }

export async function handleGetAbapKeywordDoc(_client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_GetAbapKeywordDoc.parse(args);
  const version = p.version ?? cfg.sapAbapVersion;
  const url = buildKeywordUrl(p.keyword, version);
  let result = await fetchSapDocumentation(url);
  if (!result.success) {
    const altUrl = buildKeywordUrl(p.keyword.replace(/[\s]+/g, "_"), version);
    if (altUrl !== url) {
      result = await fetchSapDocumentation(altUrl);
    }
  }
  if (!result.success) {
    return err(`Documentation for '${p.keyword}' not found (${result.content}).\nAttempted URL: ${result.url}`);
  }
  return ok(`${result.content}\n\n---\nQuelle: ${result.url}`);
}

export async function handleGetAbapClassDoc(_client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_GetAbapClassDoc.parse(args);
  const version = p.version ?? cfg.sapAbapVersion;
  const url = buildClassUrl(p.className, version);
  const result = await fetchSapDocumentation(url);
  if (!result.success) {
    return err(`Documentation for '${p.className}' not found (${result.content}).\nAttempted URL: ${result.url}`);
  }
  return ok(`${result.content}\n\n---\nQuelle: ${result.url}`);
}

export async function handleGetModuleBestPractices(_client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_GetModuleBestPractices.parse(args);
  const key = p.module.toUpperCase();
  const practices = MODULE_BEST_PRACTICES[key];
  if (!practices) {
    return err(`No best practices available for module '${p.module}'. Available modules: ${Object.keys(MODULE_BEST_PRACTICES).join(", ")}`);
  }
  return ok(practices);
}

export async function handleSearchCleanAbap(_client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_SearchCleanAbap.parse(args);
  const files = await loadCleanAbapFiles();
  const source = files.size === 1 && fs.existsSync(CLEAN_ABAP_LOCAL_DIR)
    ? "local"
    : fs.existsSync(CLEAN_ABAP_LOCAL_DIR) ? "local" : "GitHub";

  const allSections: Array<{ heading: string; content: string; file: string }> = [];
  for (const [fileName, content] of files) {
    for (const s of parseMarkdownSections(content)) {
      allSections.push({ ...s, file: fileName });
    }
  }

  const terms = p.query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const scored = allSections
    .map(s => {
      const haystack = (s.heading + "\n" + s.content).toLowerCase();
      const score = terms.reduce((acc, t) => acc + (haystack.split(t).length - 1), 0);
      const excerpt = s.content.split("\n").slice(0, 80).join("\n").trim();
      return { heading: s.heading, file: s.file, excerpt, score };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, p.maxResults ?? 2);

  if (scored.length === 0) {
    const topics = [...new Set(allSections.map(s => s.heading))].slice(0, 20).join(", ");
    return err(
      `No results for '${p.query}' in Clean ABAP Guide (${files.size} file(s) searched).\n` +
      `Available topics (selection): ${topics}`
    );
  }

  const output = scored.map(r =>
    `## ${r.heading}  _(${r.file})_\n\n${r.excerpt}`
  ).join("\n\n---\n\n");

  return ok(
    `# Clean ABAP Guide — "${p.query}" (source: ${source}, ${files.size} file(s))\n\n${output}\n\n` +
    `---\n📖 ${CLEAN_ABAP_LOCAL_DIR}`
  );
}

export async function handleSearchAbapSyntax(_client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_SearchAbapSyntax.parse(args);
  const version = p.version ?? cfg.sapAbapVersion;
  const query = p.query.trim();

  const COMPOUND_KEYWORDS: [RegExp, string][] = [
    [/\bREAD\s+TABLE\b/i,          "read_table"],
    [/\bLOOP\s+AT\b/i,             "loop_at"],
    [/\bINSERT\s+LINES\b/i,        "insert_lines"],
    [/\bDELETE\s+ADJACENT\b/i,     "delete_adjacent_duplicates"],
    [/\bSORT\b/i,                  "sort"],
    [/\bCOLLECT\b/i,               "collect"],
    [/\bMODIFY\b/i,               "modify"],
    [/\bAPPEND\b/i,               "append"],
    [/\bCONCAT\w*\b/i,            "concatenate"],
    [/\bSELECT\b/i,               "select"],
    [/\bUPDATE\b/i,               "update"],
    [/\bINSERT\b/i,               "insert"],
    [/\bDELETE\b/i,               "delete"],
    [/\bOPEN\s+CURSOR\b/i,        "open_cursor"],
    [/\bFETCH\s+NEXT\b/i,         "fetch_next_cursor"],
    [/\bCALL\s+FUNCTION\b/i,       "call_function"],
    [/\bCALL\s+METHOD\b/i,         "call_method"],
    [/\bRAISE\s+EXCEPTION\b/i,     "raise_exception"],
    [/\bFIELD-SYMBOL\b/i,          "field-symbols"],
    [/\bASSIGN\b/i,               "assign"],
    [/\bIF\b/i,                   "if"],
    [/\bCASE\b/i,                 "case"],
    [/\bDO\b/i,                   "do"],
    [/\bWHILE\b/i,               "while"],
    [/\bFORM\b/i,                 "form"],
    [/\bMETHOD\b/i,              "method"],
    [/\bCLASS\b/i,               "class"],
    [/\bINTERFACE\b/i,           "interface"],
    [/\bTRY\b/i,                 "try"],
    [/\bRAISE\b/i,               "raise"],
    [/\bWRITE\b/i,               "write"],
    [/\bMESSAGE\b/i,             "message"],
  ];

  let keywordSlug: string | null = null;
  for (const [pattern, slug] of COMPOUND_KEYWORDS) {
    if (pattern.test(query)) { keywordSlug = slug; break; }
  }

  if (!keywordSlug) {
    keywordSlug = query.split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9_]/g, "");
  }

  const v = version === "latest" ? "latest" : version;
  const base = `https://help.sap.com/doc/abapdocu_${v}_index_htm/${v}/en-US/`;
  const urlVariants = [
    `${base}abap${keywordSlug}.htm`,
    `${base}abap${keywordSlug.replace(/_/g, "")}.htm`,
    `${base}abap${keywordSlug}_clause.htm`,
    `${base}abap${keywordSlug}_clauses.htm`,
  ];

  let result: { success: boolean; content: string; url: string } | null = null;
  for (const url of urlVariants) {
    const r = await fetchSapDocumentation(url);
    if (r.success) { result = r; break; }
  }

  if (!result || !result.success) {
    return err(
      `No documentation found for '${query}'.\n` +
      `Tip: Try get_abap_keyword_doc with the exact keyword (e.g. "${keywordSlug.replace(/_/g, " ").toUpperCase()}").\n` +
      `Attempted URLs:\n${urlVariants.join("\n")}`
    );
  }

  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const lines = result.content.split("\n");
  let bestSection = "";

  let bestScore = -1;
  let bestStart = 0;
  const WINDOW = 60;
  for (let i = 0; i < lines.length; i++) {
    const window = lines.slice(i, i + WINDOW).join("\n").toLowerCase();
    const score = queryTerms.reduce((s, t) => s + (window.split(t).length - 1), 0);
    if (score > bestScore) { bestScore = score; bestStart = i; }
  }

  if (bestScore > 0) {
    const start = Math.max(0, bestStart - 5);
    bestSection = lines.slice(start, start + WINDOW + 10).join("\n").trim();
  } else {
    bestSection = lines.slice(0, 80).join("\n").trim();
  }

  return ok(
    `# ABAP Syntax: ${query}\n\n${bestSection}\n\n` +
    `---\n📖 Vollständige Dokumentation: ${result.url}`
  );
}
