/**
 * Claude web_search provider — Anthropic's server-side `web_search` tool
 * on the Messages API (https://docs.claude.com/en/docs/agents-and-tools/tool-use/web-search-tool),
 * key in `ANTHROPIC_SEARCH_API_KEY`.
 *
 * A dedicated env name on purpose: `ANTHROPIC_API_KEY` in this process
 * would shadow the claude HARNESS's setup-token auth (same trap docs/0050
 * guards for codex). The harness's CLAUDE_CODE_OAUTH_TOKEN is NOT used
 * here — a subscription token is for the Claude Code CLI, not direct API
 * calls from our own client.
 */

import { clipHead } from "@/lib/clip";
import type { WebResult } from "../web";
import type { Recency, SearchHit, SearchResults } from "../web-search";
import { recencyHint } from "./shared";

const URL_ = "https://api.anthropic.com/v1/messages";
const TIMEOUT_MS = 60_000;
const MAX_RESULTS = 8;
const MAX_SNIPPET_CHARS = 500;
const DEFAULT_MODEL = "claude-haiku-5-5";

export async function searchClaude(
  query: string,
  opts: { recency?: Recency; domain?: string } = {},
): Promise<WebResult<SearchResults>> {
  const key = process.env.ANTHROPIC_SEARCH_API_KEY;
  if (!key) {
    return { ok: false, code: "not-configured", message: "web_search via Claude needs ANTHROPIC_SEARCH_API_KEY" };
  }
  const hint = recencyHint(opts.recency);
  try {
    const response = await fetch(URL_, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_SEARCH_MODEL?.trim() || DEFAULT_MODEL,
        max_tokens: 1024,
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 2,
            ...(opts.domain ? { allowed_domains: [opts.domain] } : {}),
          },
        ],
        messages: [
          {
            role: "user",
            content:
              `Search the web for: ${query}\n${hint ? `${hint}\n` : ""}` +
              "Reply with a two-sentence factual summary of the best sources found.",
          },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, code: "http-error", message: `Anthropic answered HTTP ${response.status}: ${clipHead(await response.text().catch(() => ""), 200)}` };
    }
    const body = (await response.json()) as { content?: unknown };
    const blocks = Array.isArray(body.content) ? (body.content as Record<string, unknown>[]) : [];

    // Snippets come from the citations the model attached to its summary
    // (cited_text); the tool-result blocks carry only title + url.
    const cited = new Map<string, string>();
    for (const block of blocks) {
      if (block.type !== "text" || !Array.isArray(block.citations)) continue;
      for (const c of block.citations as Record<string, unknown>[]) {
        if (typeof c.url === "string" && typeof c.cited_text === "string" && !cited.has(c.url)) {
          cited.set(c.url, c.cited_text);
        }
      }
    }
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const block of blocks) {
      if (block.type !== "web_search_tool_result") continue;
      if (!Array.isArray(block.content)) {
        const code = (block.content as { error_code?: unknown } | undefined)?.error_code;
        return { ok: false, code: "search-error", message: `Claude web search failed: ${String(code ?? "unknown")}` };
      }
      for (const item of block.content as Record<string, unknown>[]) {
        const url = typeof item.url === "string" ? item.url : "";
        if (!url || seen.has(url)) continue;
        seen.add(url);
        const title = typeof item.title === "string" ? item.title : url;
        hits.push({
          title: clipHead(title, 300),
          url,
          snippet: clipHead(cited.get(url) ?? "", MAX_SNIPPET_CHARS),
        });
      }
    }
    if (hits.length === 0) {
      return { ok: false, code: "bad-response", message: "Claude returned no search results" };
    }
    return { ok: true, query, results: hits.slice(0, MAX_RESULTS) };
  } catch (err) {
    return {
      ok: false,
      code: "network",
      message: `Search request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
