/**
 * Tavily web_search provider — a plain REST search API
 * (https://docs.tavily.com/documentation/api-reference/endpoint/search),
 * key in `TAVILY_API_KEY`. The last stop in the order: the only backend
 * that needs nothing but a key.
 */

import { clipHead } from "@/lib/clip";
import type { WebResult } from "../web";
import type { Recency, SearchResults } from "../web-search";

const URL_ = "https://api.tavily.com/search";
const TIMEOUT_MS = 30_000;
const MAX_RESULTS = 8;
const MAX_SNIPPET_CHARS = 500;

const TIME_RANGE: Partial<Record<Recency, string>> = {
  oneDay: "day",
  oneWeek: "week",
  oneMonth: "month",
  oneYear: "year",
};

export async function searchTavily(
  query: string,
  opts: { recency?: Recency; domain?: string } = {},
): Promise<WebResult<SearchResults>> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) {
    return { ok: false, code: "not-configured", message: "web_search via Tavily needs TAVILY_API_KEY" };
  }
  const timeRange = opts.recency ? TIME_RANGE[opts.recency] : undefined;
  try {
    const response = await fetch(URL_, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        query,
        max_results: MAX_RESULTS,
        search_depth: "basic",
        ...(timeRange ? { time_range: timeRange } : {}),
        ...(opts.domain ? { include_domains: [opts.domain] } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, code: "http-error", message: `Tavily answered HTTP ${response.status}: ${clipHead(await response.text().catch(() => ""), 200)}` };
    }
    const body = (await response.json()) as { results?: unknown };
    if (!Array.isArray(body.results)) {
      return { ok: false, code: "bad-response", message: "Tavily returned no results array" };
    }
    const results: SearchResults["results"] = [];
    for (const item of body.results) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const url = typeof o.url === "string" ? o.url : "";
      const title = typeof o.title === "string" ? o.title : "";
      if (!url && !title) continue;
      results.push({
        title: clipHead(title || url, 300),
        url,
        snippet: clipHead(typeof o.content === "string" ? o.content : "", MAX_SNIPPET_CHARS),
      });
    }
    return { ok: true, query, results: results.slice(0, MAX_RESULTS) };
  } catch (err) {
    return {
      ok: false,
      code: "network",
      message: `Search request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
