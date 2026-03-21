/**
 * QUALITY tool handlers: run_syntax_check, run_atc_check, validate_ddic_references, review_clean_abap
 */

import type { ADTClient } from "abap-adt-api";
import type { ToolResult } from "../../types.js";
import { S_SyntaxCheck, S_RunAtc, S_ValidateDdic, S_ReviewCleanAbap } from "../../schemas.js";
import { resolveSyntaxContext } from "../../helpers/resolve.js";
import { CLEAN_ABAP_RULES, CLEAN_ABAP_LOCAL_DIR, loadCleanAbapFiles, parseMarkdownSections, searchCleanAbapSections } from "../../helpers/clean-abap.js";

function ok(text: string): ToolResult { return { content: [{ type: "text", text }] }; }
function err(text: string): ToolResult { return { content: [{ type: "text", text }], isError: true }; }

export async function handleRunSyntaxCheck(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_SyntaxCheck.parse(args);
  const syntaxContext = await resolveSyntaxContext(client, p.objectUrl, p.mainProgram);
  const res = await client.syntaxCheck(p.objectUrl, syntaxContext, p.source);
  const msgs     = Array.isArray(res) ? res : [];
  const errors   = msgs.filter((m: { severity: string }) => ["E", "A"].includes(m.severity));
  const warnings = msgs.filter((m: { severity: string }) => m.severity === "W");
  const summary  = errors.length === 0
    ? `✅ Syntax OK${warnings.length > 0 ? ` (${warnings.length} warning(s))` : ""}`
    : `❌ ${errors.length} error(s), ${warnings.length} warning(s)`;
  return (errors.length === 0 ? ok : err)(`${summary}\n\n${JSON.stringify(msgs, null, 2)}`);
}

export async function handleRunAtcCheck(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_RunAtc.parse(args);
  const variant = p.checkVariant ?? "DEFAULT";
  const runResult = await client.createAtcRun(variant, p.objectUrl);
  const worklist = await client.atcWorklists(runResult.id);
  const findings = worklist.objects ?? [];
  if (findings.length === 0) return ok("No ATC findings — object is clean.");
  const summary = `ATC: ${findings.length} object(s) with findings`;
  return ok(`${summary}\n\n${JSON.stringify(worklist, null, 2)}`);
}

export async function handleValidateDdicReferences(client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_ValidateDdic.parse(args);
  const source = p.source;

  const tableFieldMap = new Map<string, Set<string>>();

  const patterns = [
    /\bTYPE\s+([A-Z][A-Z0-9_]{1,30})-([A-Z][A-Z0-9_]{1,30})\b/gi,
    /\bLIKE\s+([A-Z][A-Z0-9_]{1,30})-([A-Z][A-Z0-9_]{1,30})\b/gi,
  ];

  const skipTable = (t: string) =>
    /^[LG][TSVO]_/.test(t) || /^[LG]S_/.test(t) ||
    /^(C|N|I|F|P|X|D|T|STRING|XSTRING|ABAP_.*)$/.test(t);

  const SQL_KW = new Set([
    'SINGLE','DISTINCT','COUNT','SUM','AVG','MIN','MAX','AS','CASE','WHEN',
    'THEN','ELSE','END','UP','TO','ROWS','APPENDING','CORRESPONDING','FIELDS',
    'OF','TABLE','INTO','FOR','ALL','ENTRIES','IN','AND','OR','NOT',
    'ORDER','BY','GROUP','HAVING','INNER','LEFT','RIGHT','OUTER','JOIN','ON',
    'CROSS','UNION','EXCEPT','INTERSECT','EXISTS','BETWEEN','LIKE','IS','NULL',
    'ASCENDING','DESCENDING','CLIENT','SPECIFIED','BYPASSING','BUFFER','CONNECTION',
    'WHERE','FROM','SELECT','UPDATE','DELETE','INSERT','MODIFY','DATA','VALUE',
  ]);

  const addField = (t: string, f: string) => {
    if (skipTable(t) || SQL_KW.has(f)) return;
    if (!tableFieldMap.has(t)) tableFieldMap.set(t, new Set());
    tableFieldMap.get(t)!.add(f);
  };

  for (const pattern of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(source)) !== null) {
      addField(m[1].toUpperCase(), m[2].toUpperCase());
    }
  }

  const tildePattern = /\b([A-Z][A-Z0-9_]{2,30})~([A-Z][A-Z0-9_]{1,30})\b/gi;
  let tm: RegExpExecArray | null;
  while ((tm = tildePattern.exec(source)) !== null) {
    addField(tm[1].toUpperCase(), tm[2].toUpperCase());
  }

  const selectPattern = /\bSELECT\s+(?:SINGLE\s+|DISTINCT\s+)?([\s\S]*?)\bFROM\s+([A-Z][A-Z0-9_\/]{2,30})\b([\s\S]*?)\./gi;
  let sm: RegExpExecArray | null;
  while ((sm = selectPattern.exec(source)) !== null) {
    const [, selectList, tableName, rest] = sm;
    const t = tableName.toUpperCase();
    if (skipTable(t)) continue;

    if (selectList.trim() !== '*') {
      const tokens = selectList.match(/\b([A-Z_][A-Z0-9_]*)\b/gi) ?? [];
      for (const tok of tokens) {
        const u = tok.toUpperCase();
        if (!SQL_KW.has(u)) addField(t, u);
      }
    }

    const whereMatch = rest.match(/\bWHERE\b([\s\S]*)/i);
    if (whereMatch) {
      for (const fm of whereMatch[1].matchAll(/\b([A-Z_][A-Z0-9_]*)\s*(?:=|<>|>=|<=|>|<|\bIN\b|\bLIKE\b|\bBETWEEN\b|\bIS\b)/gi)) {
        const u = fm[1].toUpperCase();
        if (!SQL_KW.has(u)) addField(t, u);
      }
    }
  }

  if (tableFieldMap.size === 0) {
    return ok("✅ No DDIC table field references found. No validation needed.");
  }

  const tableNames = [...tableFieldMap.keys()];
  const results: string[] = [];
  const errors: string[] = [];
  let validCount = 0;
  let errorCount = 0;

  await Promise.all(tableNames.map(async (tableName) => {
    try {
      const ddic = await client.ddicElement(tableName);
      const knownFields = new Set(
        (ddic.children ?? []).map((c: { name: string }) => c.name.toUpperCase())
      );
      const referencedFields = tableFieldMap.get(tableName)!;

      for (const field of referencedFields) {
        if (knownFields.has(field)) {
          validCount++;
        } else {
          errorCount++;
          const similar = [...knownFields].filter(k =>
            k.includes(field) || field.includes(k) ||
            (k.length > 3 && field.length > 3 && (k.startsWith(field.substring(0, 4)) || field.startsWith(k.substring(0, 4))))
          ).slice(0, 5);
          const hint = similar.length > 0 ? ` → Similar fields: ${similar.join(', ')}` : ` (table has ${knownFields.size} fields)`;
          errors.push(`  ❌ ${tableName}-${field}: Field not found${hint}`);
        }
      }

      results.push(`  ✅ ${tableName}: ${referencedFields.size} referenced field(s) checked`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push(`  ⚠️  ${tableName}: DDIC not resolvable — ${msg.substring(0, 80)}`);
    }
  }));

  const summary = [
    `🔍 DDIC field validation for ${tableNames.length} table(s)/structure(s):`,
    ...results.sort(),
    "",
  ];

  if (errorCount > 0) {
    return err([
      ...summary,
      `❌ ${errorCount} invalid field reference(s) found:`,
      ...errors.sort(),
      "",
      "⚠️ These fields do not exist in the DDIC — fix the field names before calling write_abap_source!",
      "💡 Tip: Use get_ddic_element with the table name to see all available fields.",
    ].join("\n"));
  }

  return ok([
    ...summary,
    `✅ All ${validCount} field reference(s) are valid.`,
  ].join("\n"));
}

export async function handleReviewCleanAbap(_client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  const p = S_ReviewCleanAbap.parse(args);
  const maxFindings = p.maxFindings ?? 10;
  const sourceLines = p.source.split("\n");
  const fullSource = p.source;

  const findingsMap = new Map<string, {
    rule: typeof CLEAN_ABAP_RULES[0];
    line: number;
    lineText: string;
    count: number;
  }>();

  for (const rule of CLEAN_ABAP_RULES) {
    if (rule.multiline) {
      const match = rule.pattern.exec(fullSource);
      if (match) {
        const lineNum = fullSource.substring(0, match.index).split("\n").length;
        const lineText = sourceLines[lineNum - 1] || "";
        let count = 0;
        const globalPattern = new RegExp(rule.pattern.source, rule.pattern.flags + (rule.pattern.flags.includes("g") ? "" : "g"));
        let m;
        while ((m = globalPattern.exec(fullSource)) !== null) {
          count++;
          if (m.index === globalPattern.lastIndex) globalPattern.lastIndex++;
        }
        findingsMap.set(rule.id, { rule, line: lineNum, lineText, count: Math.max(count, 1) });
      }
    } else {
      for (let i = 0; i < sourceLines.length; i++) {
        if (rule.pattern.test(sourceLines[i])) {
          if (!findingsMap.has(rule.id)) {
            findingsMap.set(rule.id, { rule, line: i + 1, lineText: sourceLines[i], count: 1 });
          } else {
            findingsMap.get(rule.id)!.count++;
          }
        }
      }
    }
  }

  const findings = [...findingsMap.values()]
    .sort((a, b) => a.line - b.line)
    .slice(0, maxFindings);

  if (findings.length === 0) {
    return ok(
      `✅ No Clean ABAP anti-patterns detected (${CLEAN_ABAP_RULES.length} rules checked).\n\n` +
      `📖 ${CLEAN_ABAP_LOCAL_DIR}`
    );
  }

  const files = await loadCleanAbapFiles();
  const allSections: Array<{ heading: string; content: string }> = [];
  for (const [, content] of files) {
    for (const s of parseMarkdownSections(content)) {
      allSections.push(s);
    }
  }

  const outputParts: string[] = [];
  for (const f of findings) {
    const truncLine = f.lineText.trim().length > 120
      ? f.lineText.trim().substring(0, 120) + "…"
      : f.lineText.trim();
    const countInfo = f.count > 1 ? ` (${f.count}x in source)` : "";

    let guidelinePart = "";
    const guideResults = searchCleanAbapSections(allSections, f.rule.guidelineQuery, 1);
    if (guideResults.length > 0) {
      const excerpt = guideResults[0].excerpt.split("\n").slice(0, 15).join("\n").trim();
      guidelinePart = `\n→ Clean ABAP § **${guideResults[0].heading}**\n\`\`\`\n${excerpt}\n\`\`\``;
    }

    outputParts.push(
      `## [${f.rule.category}] ${f.rule.id} — line ${f.line}${countInfo}\n` +
      `❌ ${f.rule.message}\n` +
      `   \`${truncLine}\`` +
      guidelinePart
    );
  }

  const totalAntiPatterns = [...findingsMap.values()].reduce((sum, f) => sum + f.count, 0);
  return ok(
    `# Clean ABAP Review — ${findings.length} finding(s), ${totalAntiPatterns} occurrence(s)\n\n` +
    outputParts.join("\n\n---\n\n") +
    `\n\n---\n${CLEAN_ABAP_RULES.length} rules checked | 📖 ${CLEAN_ABAP_LOCAL_DIR}`
  );
}
