/**
 * Codex web_search provider — the hosted `web_search` tool on the ChatGPT
 * backend the codex harness already talks to, called directly with the
 * app's stored ChatGPT login (lib/harness-auth/codex.ts). No sandbox, no
 * bridge: one streamed Responses call per search.
 *
 * The login file is read as-is. Refreshing near-expiry tokens stays the
 * adapter's job (it does it when a codex session starts); a login too
 * close to expiry is simply "not configured" here, so the next provider
 * answers instead.
 */

import { clipHead } from "@/lib/clip";
import { codexCredential } from "@/lib/harness-auth/codex";
import type { WebResult } from "../web";
import type { Recency, SearchHit, SearchResults } from "../web-search";
import { recencyHint } from "./shared";

const URL_ = "https://chatgpt.com/backend-api/codex/responses";
const TIMEOUT_MS = 90_000;
const MAX_RESULTS = 8;
const MAX_SNIPPET_CHARS = 500;
const DEFAULT_MODEL = "gpt-5.6-luna";

export async function searchCodex(
  query: string,
  opts: { recency?: Recency; domain?: string } = {},
): Promise<WebResult<SearchResults>> {
  const credential = codexCredential();
  if (!credential.ok) return { ok: false, code: "not-configured", message: credential.message };
  // parseCodexAuth already proved the shape; the token is in the file text.
  const accessToken = (JSON.parse(credential.json) as { tokens: { access_token: string } }).tokens.access_token;

  const hint = recencyHint(opts.recency);
  const scoped = opts.domain ? `${query} site:${opts.domain}` : query;
  try {
    const response = await fetch(URL_, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        "openai-beta": "responses=experimental",
        originator: "codex_cli_rs",
        ...(credential.accountId ? { "chatgpt-account-id": credential.accountId } : {}),
      },
      body: JSON.stringify({
        model: process.env.CODEX_SEARCH_MODEL?.trim() || DEFAULT_MODEL,
        instructions:
          "You are a search backend. Search the web for the user's query, then reply with a short " +
          `factual summary, citing every source you used. ${hint}`.trim(),
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: scoped }] }],
        tools: [{ type: "web_search" }],
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
        stream: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, code: "http-error", message: `Codex answered HTTP ${response.status}: ${clipHead(await response.text().catch(() => ""), 200)}` };
    }
    const hits = hitsFromStream(await response.text());
    if (hits.length === 0) {
      return { ok: false, code: "bad-response", message: "Codex returned no cited search results" };
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

/**
 * Hits from a Responses SSE body: every `url_citation` annotation on the
 * answer's output_text becomes one hit (deduped by url); the snippet is
 * the sentence the citation sits at the end of.
 */
export function hitsFromStream(sse: string): SearchHit[] {
  const items: Record<string, unknown>[] = [];
  for (const line of sse.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    let event: { type?: string; item?: unknown; response?: { output?: unknown } };
    try {
      event = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    if (event.type === "response.output_item.done" && event.item && typeof event.item === "object") {
      items.push(event.item as Record<string, unknown>);
    }
  }
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content as Record<string, unknown>[]) {
      if (part.type !== "output_text" || typeof part.text !== "string" || !Array.isArray(part.annotations)) continue;
      const text = part.text;
      for (const a of part.annotations as Record<string, unknown>[]) {
        if (a.type !== "url_citation" || typeof a.url !== "string" || seen.has(a.url)) continue;
        seen.add(a.url);
        const start = typeof a.start_index === "number" ? a.start_index : 0;
        const lead = text.slice(Math.max(0, start - 400), start);
        const snippet = lead.slice(lead.search(/[^\n]*$/)).trim();
        hits.push({
          title: clipHead(typeof a.title === "string" && a.title ? a.title : a.url, 300),
          url: a.url,
          snippet: clipHead(snippet, MAX_SNIPPET_CHARS),
        });
      }
    }
  }
  return hits;
}
