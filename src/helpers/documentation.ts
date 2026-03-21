/**
 * SAP documentation fetching and HTML-to-Markdown conversion.
 */

export async function fetchSapDocumentation(url: string): Promise<{ success: boolean; content: string; url: string }> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { "Accept": "text/html", "User-Agent": "ABAP-MCP-Server/2.0" },
    });
    if (!resp.ok) return { success: false, content: `HTTP ${resp.status}`, url };
    const html = await resp.text();
    return { success: true, content: extractMainContent(html), url };
  } catch (e) {
    return { success: false, content: (e as Error).message, url };
  }
}

export function extractMainContent(html: string): string {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : "";

  // Try to extract main content area
  let content = "";
  const contentMatch = html.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<div[^>]*class="[^"]*footer)/i)
    ?? html.match(/<section[^>]*>([\s\S]*?)<\/section>/i)
    ?? html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (contentMatch) content = contentMatch[1];
  else content = html;

  // HTML → Markdown-like conversion
  content = content
    // Remove script/style blocks
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    // Headers
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n")
    // Code blocks
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```abap\n$1\n```\n")
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    // Bold/italic
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**")
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**")
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "*$1*")
    // Lists
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n")
    // Line breaks / paragraphs
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<p[^>]*>/gi, "")
    // Tables: simple row extraction
    .replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_, row: string) => {
      const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => m[1].trim());
      return cells.join(" | ") + "\n";
    })
    // Remove remaining HTML tags
    .replace(/<[^>]+>/g, "")
    // Decode entities
    .replace(/&nbsp;/g, " ");

  content = decodeHtmlEntities(content);

  // Normalize whitespace
  content = content
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Truncate to ~8000 chars
  if (content.length > 8000) {
    content = content.substring(0, 8000) + "\n\n... (truncated)";
  }

  return title ? `# ${title}\n\n${content}` : content;
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
