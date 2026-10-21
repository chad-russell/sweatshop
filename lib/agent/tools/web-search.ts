/**
 * The web_search core: one tool, several backends tried in order. The
 * first provider that is configured AND answers wins; a provider that is
 * missing its credential is skipped silently, one that fails (quota,
 * network, 401) falls through to the next. Default order:
 *
 *   zai → codex → claude → tavily
 *
 * (cursor has no standalone search API — only its CLI agent can search,
 * and that needs a sandbox run — so it has no slot.) `WEB_SEARCH_PROVIDERS`
 * (comma-separated ids) reorders or narrows the list.
 *
 * Results are value-shaped (0015 style). Content from the web is
 * untrusted data, same framing as web_fetch.
 */

import type { WebResult } from "./web";
import { searchClaude } from "./search-providers/claude";
import { searchCodex } from "./search-providers/codex";
import { searchTavily } from "./search-providers/tavily";
import { searchZai } from "./search-providers/zai";

const RECENCY = ["oneDay", "oneWeek", "oneMonth", "oneYear", "noLimit"] as const;
export type Recency = (typeof RECENCY)[number];
export const recencyValues = RECENCY;

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResults {
  query: string;
  results: SearchHit[];
  /** Which backend answered (absent on a bare provider call). */
  provider?: SearchProviderId;
}

export type SearchOpts = { recency?: Recency; domain?: string };
export type SearchProvider = (query: string, opts: SearchOpts) => Promise<WebResult<SearchResults>>;

const PROVIDERS = {
  zai: searchZai,
  codex: searchCodex,
  claude: searchClaude,
  tavily: searchTavily,
} satisfies Record<string, SearchProvider>;

export type SearchProviderId = keyof typeof PROVIDERS;

const DEFAULT_ORDER: readonly SearchProviderId[] = ["zai", "codex", "claude", "tavily"];

/** The provider order: `WEB_SEARCH_PROVIDERS` when it names any known id, else the default. */
export function searchProviderOrder(env: Readonly<Record<string, string | undefined>> = process.env): SearchProviderId[] {
  const named = (env.WEB_SEARCH_PROVIDERS ?? "")
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter((id): id is SearchProviderId => id in PROVIDERS);
  return named.length > 0 ? [...new Set(named)] : [...DEFAULT_ORDER];
}

export async function searchWeb(query: string, opts: SearchOpts = {}): Promise<WebResult<SearchResults>> {
  const order = searchProviderOrder();
  const failures: { id: SearchProviderId; code: string; message: string }[] = [];
  for (const id of order) {
    const result = await PROVIDERS[id](query, opts);
    if (result.ok) return { ...result, provider: id };
    if (result.code !== "not-configured") failures.push({ id, code: result.code, message: result.message });
  }
  const first = failures[0];
  if (first) {
    // The first real failure leads (its code is the useful one); the rest
    // are listed so a fall-through that also failed is not invisible.
    const others = failures.slice(1).map((f) => `${f.id}: ${f.message}`);
    return {
      ok: false,
      code: first.code,
      message: [`${first.id}: ${first.message}`, ...others].join(" | "),
    };
  }
  return {
    ok: false,
    code: "not-configured",
    message:
      "web_search has no configured backend on this server — set ZAI_API_KEY, log in to codex on /settings, " +
      "or set ANTHROPIC_SEARCH_API_KEY or TAVILY_API_KEY",
  };
}
