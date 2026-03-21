/**
 * Clean ABAP styleguide utilities — rule definitions, file loading, and search.
 */

import * as fs from "fs";
import * as path from "path";

// ── Clean ABAP Anti-Pattern Rules (static analysis) ──────────────────

export interface CleanAbapRule {
  id: string;
  pattern: RegExp;
  message: string;
  guidelineQuery: string;
  category: "Names" | "Language" | "Tables" | "Strings" | "Methods" | "ErrorHandling";
  multiline?: boolean;
}

export const CLEAN_ABAP_RULES: CleanAbapRule[] = [
  // Names
  { id: "HUNGARIAN_NOTATION",
    pattern: /^\s*DATA\s+[lg][vtso]_\w+/im,
    message: "Hungarian notation prefix (e.g. lv_, lt_, gs_). Clean ABAP avoids type-encoding prefixes.",
    guidelineQuery: "hungarian notation naming prefixes avoid encodings",
    category: "Names" },
  // Language
  { id: "MOVE_STATEMENT",
    pattern: /\bMOVE\s+\S+\s+TO\b/i,
    message: "Obsolete MOVE ... TO. Use = operator instead.",
    guidelineQuery: "MOVE obsolete assignment operator",
    category: "Language" },
  { id: "COMPUTE_STATEMENT",
    pattern: /\bCOMPUTE\b/i,
    message: "Obsolete COMPUTE statement. Use arithmetic expressions directly.",
    guidelineQuery: "COMPUTE obsolete arithmetic",
    category: "Language" },
  { id: "ADD_SUBTRACT",
    pattern: /\b(ADD|SUBTRACT)\s+\S+\s+TO\b/i,
    message: "Obsolete ADD/SUBTRACT. Use += / -= operators.",
    guidelineQuery: "ADD SUBTRACT obsolete arithmetic operators",
    category: "Language" },
  { id: "MULTIPLY_DIVIDE",
    pattern: /\b(MULTIPLY|DIVIDE)\s+\S+\s+BY\b/i,
    message: "Obsolete MULTIPLY/DIVIDE. Use *= / /= operators.",
    guidelineQuery: "MULTIPLY DIVIDE obsolete arithmetic operators",
    category: "Language" },
  { id: "CALL_METHOD",
    pattern: /\bCALL\s+METHOD\b/i,
    message: "Old OO syntax CALL METHOD. Use functional call: object->method( ).",
    guidelineQuery: "CALL METHOD obsolete functional style",
    category: "Language" },
  { id: "FORM_DEFINITION",
    pattern: /^\s*FORM\s+\w+/im,
    message: "FORM subroutine. Use methods in classes instead.",
    guidelineQuery: "FORM subroutine obsolete methods classes",
    category: "Language" },
  // Strings
  { id: "CONCATENATE_STATEMENT",
    pattern: /\bCONCATENATE\b/i,
    message: "CONCATENATE statement. Use string template |{ a }{ b }| instead.",
    guidelineQuery: "CONCATENATE string template pipe operator",
    category: "Strings" },
  // Tables
  { id: "SELECT_ENDSELECT",
    pattern: /\bSELECT\b[\s\S]*?\bENDSELECT\b/i,
    message: "SELECT...ENDSELECT loop. Use SELECT INTO TABLE @DATA(...) for bulk reads.",
    guidelineQuery: "SELECT ENDSELECT loop INTO TABLE modern SQL",
    category: "Tables",
    multiline: true },
  // Methods
  { id: "CHECK_IN_METHOD",
    pattern: /\bMETHOD\b[\s\S]*?\bCHECK\b/,
    message: "CHECK statement inside METHOD body. Use IF ... RETURN instead.",
    guidelineQuery: "CHECK RETURN method early exit",
    category: "Methods",
    multiline: true },
  // Error handling
  { id: "CALL_FUNCTION_SYSUBRC",
    pattern: /CALL\s+FUNCTION\s+['"][^'"]+['"][\s\S]{0,300}?(?:IF\s+sy-subrc|WHEN\s+sy-subrc)/i,
    message: "CALL FUNCTION followed by sy-subrc check. Use EXCEPTIONS + TRY/CATCH with CX_*.",
    guidelineQuery: "sy-subrc CALL FUNCTION exceptions TRY CATCH error handling",
    category: "ErrorHandling",
    multiline: true },
];

// ── Clean ABAP File Loading ──────────────────────────────────────────

export const CLEAN_ABAP_LOCAL_DIR = path.resolve(process.cwd(), "clean-abap");
const CLEAN_ABAP_URL = "https://raw.githubusercontent.com/SAP/styleguides/main/clean-abap/CleanABAP.md";

let cleanAbapSectionCache: Map<string, string> | null = null;

/** Lädt alle Clean ABAP Markdown-Dateien (lokal bevorzugt, GitHub als Fallback) */
export async function loadCleanAbapFiles(): Promise<Map<string, string>> {
  if (cleanAbapSectionCache) return cleanAbapSectionCache;

  const files = new Map<string, string>();

  // Lokale Dateien verwenden wenn vorhanden
  if (fs.existsSync(CLEAN_ABAP_LOCAL_DIR)) {
    const readMd = (filePath: string, label: string) => {
      try {
        files.set(label, fs.readFileSync(filePath, "utf-8"));
      } catch { /* ignorieren */ }
    };

    readMd(path.join(CLEAN_ABAP_LOCAL_DIR, "CleanABAP.md"), "CleanABAP");

    const subDir = path.join(CLEAN_ABAP_LOCAL_DIR, "sub-sections");
    if (fs.existsSync(subDir)) {
      for (const f of fs.readdirSync(subDir)) {
        if (f.endsWith(".md")) {
          readMd(path.join(subDir, f), `sub-sections/${f.replace(".md", "")}`);
        }
      }
    }
  }

  // Fallback: GitHub
  if (files.size === 0) {
    const resp = await fetch(CLEAN_ABAP_URL, {
      signal: AbortSignal.timeout(20_000),
      headers: { "User-Agent": "ABAP-MCP-Server/2.0" },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} loading Clean ABAP Guide`);
    files.set("CleanABAP", await resp.text());
  }

  cleanAbapSectionCache = files;
  return files;
}

/** Zerlegt einen Markdown-Text in Abschnitte anhand von ## Überschriften */
export function parseMarkdownSections(md: string): Array<{ heading: string; content: string }> {
  const sections: Array<{ heading: string; content: string }> = [];
  const lines = md.split("\n");
  let currentHeading = "(Intro)";
  let currentLines: string[] = [];

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)/);
    if (h2) {
      if (currentLines.length > 0)
        sections.push({ heading: currentHeading, content: currentLines.join("\n").trim() });
      currentHeading = h2[1].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  if (currentLines.length > 0)
    sections.push({ heading: currentHeading, content: currentLines.join("\n").trim() });
  return sections;
}

/** Sucht im Clean ABAP Guide nach dem relevantesten Abschnitt */
export function searchCleanAbapSections(
  sections: Array<{ heading: string; content: string }>,
  query: string,
  maxResults = 3
): Array<{ heading: string; excerpt: string; score: number }> {
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  return sections
    .map(s => {
      const haystack = (s.heading + "\n" + s.content).toLowerCase();
      const score = terms.reduce((acc, t) => acc + (haystack.split(t).length - 1), 0);
      // Abschnitt auf max. ~100 Zeilen kürzen
      const excerpt = s.content.split("\n").slice(0, 100).join("\n").trim();
      return { heading: s.heading, excerpt, score };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}
