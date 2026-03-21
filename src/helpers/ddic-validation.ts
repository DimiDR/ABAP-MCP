/**
 * DDIC field reference validation — validates table-field references against DDIC metadata.
 */

import type { ADTClient } from "abap-adt-api";

export type DdicValidationResult = {
  tableCount: number;
  validCount: number;
  invalid: string[];
  checks: string[];
};

export async function validateDdicReferencesInternal(client: ADTClient, source: string): Promise<DdicValidationResult> {
  const tableFieldMap = new Map<string, Set<string>>(); // tableName → Set<fieldName>

  // Strip ABAP comments before processing to avoid false matches:
  // - Full-line comments: lines starting with optional whitespace + *
  // - Inline comments: everything after " on a code line
  const stripComments = (src: string): string =>
    src.split('\n').map(line => {
      if (/^\s*\*/.test(line)) return '';        // full-line comment
      const idx = line.indexOf('"');
      return idx >= 0 ? line.substring(0, idx) : line;
    }).join('\n');

  const cleanSource = stripComments(source);

  const patterns = [
    /\bTYPE\s+([A-Z][A-Z0-9_]{1,30})-([A-Z][A-Z0-9_]{1,30})\b/gi,
    /\bLIKE\s+([A-Z][A-Z0-9_]{1,30})-([A-Z][A-Z0-9_]{1,30})\b/gi,
  ];

  const skipTable = (t: string) =>
    /^[LG][TSVO]_/.test(t) || /^[LG]S_/.test(t) ||
    /^(C|N|I|F|P|X|D|T|STRING|XSTRING|ABAP_.*)$/.test(t);

  const SQL_KW = new Set([
    "SINGLE", "DISTINCT", "COUNT", "SUM", "AVG", "MIN", "MAX", "AS", "CASE", "WHEN",
    "THEN", "ELSE", "END", "UP", "TO", "ROWS", "APPENDING", "CORRESPONDING", "FIELDS",
    "OF", "TABLE", "INTO", "FOR", "ALL", "ENTRIES", "IN", "AND", "OR", "NOT",
    "ORDER", "BY", "GROUP", "HAVING", "INNER", "LEFT", "RIGHT", "OUTER", "JOIN", "ON",
    "CROSS", "UNION", "EXCEPT", "INTERSECT", "EXISTS", "BETWEEN", "LIKE", "IS", "NULL",
    "ASCENDING", "DESCENDING", "CLIENT", "SPECIFIED", "BYPASSING", "BUFFER", "CONNECTION",
    "WHERE", "FROM", "SELECT", "UPDATE", "DELETE", "INSERT", "MODIFY", "DATA", "VALUE",
  ]);

  const addField = (t: string, f: string) => {
    if (skipTable(t) || SQL_KW.has(f)) return;
    if (!tableFieldMap.has(t)) tableFieldMap.set(t, new Set());
    tableFieldMap.get(t)!.add(f);
  };

  for (const pattern of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(cleanSource)) !== null) {
      addField(m[1].toUpperCase(), m[2].toUpperCase());
    }
  }

  const tildePattern = /\b([A-Z][A-Z0-9_]{2,30})~([A-Z][A-Z0-9_]{1,30})\b/gi;
  let tm: RegExpExecArray | null;
  while ((tm = tildePattern.exec(cleanSource)) !== null) {
    addField(tm[1].toUpperCase(), tm[2].toUpperCase());
  }

  const selectPattern = /\bSELECT\s+(?:SINGLE\s+|DISTINCT\s+)?([\s\S]*?)\bFROM\s+([A-Z][A-Z0-9_\/]{2,30})\b([\s\S]*?)\./gi;
  let sm: RegExpExecArray | null;
  while ((sm = selectPattern.exec(cleanSource)) !== null) {
    const [, selectList, tableName, rest] = sm;
    const t = tableName.toUpperCase();
    if (skipTable(t)) continue;

    // Skip SELECT field list for JOIN queries: fields may belong to joined tables,
    // not the main FROM table. Tilde patterns (table~field) handle JOIN fields correctly.
    const hasJoin = /\b(?:INNER|LEFT|RIGHT|OUTER|CROSS)\s+JOIN\b/i.test(rest);
    if (!hasJoin && selectList.trim() !== "*") {
      const tokens = selectList.match(/\b([A-Z_][A-Z0-9_]*)\b/gi) ?? [];
      for (const tok of tokens) {
        const u = tok.toUpperCase();
        if (!SQL_KW.has(u)) addField(t, u);
      }
    }

    const whereMatch = rest.match(/\bWHERE\b([\s\S]*)/i);
    if (whereMatch) {
      // Remove subqueries (inner SELECT ... ) to avoid attributing their WHERE fields
      // to the outer table (e.g. KONV-VBELN from a nested SELECT FROM VBAK).
      const whereClause = whereMatch[1].replace(/\(\s*SELECT\s+[\s\S]*?\)/gi, '');

      // Skip fields that are tilde-qualified (table~field) — already handled above.
      // Also skip fields in JOIN queries to avoid cross-table attribution.
      if (!hasJoin) {
        for (const fm of whereClause.matchAll(/(?<![~\w])([A-Z_][A-Z0-9_]*)\s*(?:=|<>|>=|<=|>|<|\bIN\b|\bLIKE\b|\bBETWEEN\b|\bIS\b)/gi)) {
          const u = fm[1].toUpperCase();
          if (!SQL_KW.has(u)) addField(t, u);
        }
      }
    }
  }

  // Post-processing: remove field entries that are themselves table names
  // (table names accidentally added from SELECT field lists in non-JOIN queries)
  const allTableNames = new Set(tableFieldMap.keys());
  for (const [, fields] of tableFieldMap) {
    for (const field of [...fields]) {
      if (allTableNames.has(field)) fields.delete(field);
    }
  }
  for (const [table, fields] of tableFieldMap) {
    if (fields.size === 0) tableFieldMap.delete(table);
  }

  if (tableFieldMap.size === 0) {
    return { tableCount: 0, validCount: 0, invalid: [], checks: [] };
  }

  const tableNames = [...tableFieldMap.keys()];
  const checks: string[] = [];
  const invalid: string[] = [];
  let validCount = 0;

  await Promise.all(tableNames.map(async (tableName) => {
    try {
      const ddic = await client.ddicElement(tableName);
      const knownFields = new Set((ddic.children ?? []).map((c: { name: string }) => c.name.toUpperCase()));
      const referencedFields = tableFieldMap.get(tableName)!;

      for (const field of referencedFields) {
        if (knownFields.has(field)) {
          validCount++;
        } else {
          invalid.push(`  ❌ ${tableName}-${field}: Field not found (table has ${knownFields.size} fields)`);
        }
      }

      checks.push(`  ✅ ${tableName}: ${referencedFields.size} referenced fields checked`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      checks.push(`  ⚠️  ${tableName}: DDIC not resolvable — ${msg.substring(0, 80)}`);
    }
  }));

  return { tableCount: tableNames.length, validCount, invalid, checks: checks.sort() };
}
