/**
 * WEBSEARCH tool handler: search_sap_web
 * Searches SAP Help, SAP Community and SAP Notes via Tavily Search API.
 * Returns compact results (title + URL + snippet) to minimize token usage.
 */

import type { ADTClient } from "abap-adt-api";
import type { ToolResult } from "../../types.js";
import { S_SearchSapWeb } from "../../schemas.js";
import { cfg } from "../../config.js";

function ok(text: string): ToolResult { return { content: [{ type: "text", text }] }; }
function err(text: string): ToolResult { return { content: [{ type: "text", text }], isError: true }; }

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

interface TavilyResponse {
  results: TavilyResult[];
  query: string;
}

const SOURCE_DOMAINS: Record<string, string[]> = {
  help:      ["help.sap.com"],
  community: ["community.sap.com"],
  notes:     ["me.sap.com", "launchpad.support.sap.com"],
};

const SOURCE_LABELS: Record<string, string> = {
  help:      "SAP Help",
  community: "SAP Community",
  notes:     "SAP Notes/KBA",
};

async function tavilySearch(
  query: string,
  includeDomains: string[],
  maxResults: number,
): Promise<TavilyResult[]> {
  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      api_key: cfg.tavilyApiKey,
      query,
      max_results: maxResults,
      include_domains: includeDomains,
      search_depth: "basic",
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Tavily API HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = (await resp.json()) as TavilyResponse;
  return data.results ?? [];
}

function formatResults(source: string, items: TavilyResult[]): string {
  if (items.length === 0) return `### ${SOURCE_LABELS[source]}\nKeine Treffer.`;

  const lines = items.map((item, i) =>
    `${i + 1}. **${item.title}**\n   ${item.url}\n   ${item.content.replace(/\n/g, " ").trim().slice(0, 200)}`
  );
  return `### ${SOURCE_LABELS[source]} (${items.length} Treffer)\n\n${lines.join("\n\n")}`;
}

export async function handleSearchSapWeb(_client: ADTClient, args: Record<string, unknown>): Promise<ToolResult> {
  if (!cfg.tavilyApiKey) {
    return err(
      "Tavily API nicht konfiguriert. " +
      "Bitte TAVILY_API_KEY in der .env setzen.\n" +
      "Setup: https://tavily.com/ → Sign up → API Key kopieren.\n" +
      "Free Tier: 1000 Searches/Monat."
    );
  }

  const p = S_SearchSapWeb.parse(args);
  const sources = p.sources ?? ["help", "community", "notes"];
  const maxResults = p.maxResults ?? 5;

  // Enrich query with SAP ABAP context
  const enrichedQuery = `SAP ABAP ${p.query}`;

  // Run all source searches in parallel
  const results = await Promise.allSettled(
    sources.map(async (source) => {
      const domains = SOURCE_DOMAINS[source];
      if (!domains) return { source, items: [] as TavilyResult[] };
      const items = await tavilySearch(enrichedQuery, domains, maxResults);
      return { source, items };
    })
  );

  const sections: string[] = [];
  let totalHits = 0;

  for (const result of results) {
    if (result.status === "fulfilled") {
      const { source, items } = result.value;
      totalHits += items.length;
      sections.push(formatResults(source, items));
    } else {
      sections.push(`### Fehler\n${result.reason}`);
    }
  }

  if (totalHits === 0) {
    return ok(
      `# SAP Web Search: "${p.query}"\n\nKeine Treffer gefunden.\n\n` +
      `**Tipps:**\n- Andere Suchbegriffe verwenden\n- Fehlermeldung kürzen\n- Englische Begriffe probieren`
    );
  }

  return ok(
    `# SAP Web Search: "${p.query}"\n\n${sections.join("\n\n---\n\n")}\n\n` +
    `---\n🔍 ${totalHits} Treffer aus ${sources.map(s => SOURCE_LABELS[s]).join(", ")}`
  );
}
