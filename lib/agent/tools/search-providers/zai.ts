/**
 * 1.5 (roadmap): the Z.AI web_search provider — Z.AI's coding-plan MCP tool
 * (`web_search_prime`), reached over hand-rolled streamable-HTTP
 * JSON-RPC. No SDK dependency on purpose: the protocol surface we use
 * is two calls. Verified against the live endpoint 2026-10-08:
 *
 *   - POST initialize → 200 with an `mcp-session-id` response header
 *     (the session-init quirk the oh-my-pi changelog notes: responses
 *     are ALWAYS `text/event-stream`, never plain JSON);
 *   - POST tools/call with that header → SSE `event:message` lines
 *     whose `data:` payload is the JSON-RPC result;
 *   - the result's content[0].text is ITSELF a JSON-encoded string of
 *     the results array — parsed twice, guarded.
 *
 * Results are value-shaped (0015 style). Content from the web is
 * untrusted data, same framing as web_fetch.
 */

import type { WebResult } from "../web";
import type { Recency, SearchHit, SearchResults } from "../web-search";
import { clipHead } from "@/lib/clip";

const MCP_URL = "https://api.z.ai/api/mcp/web_search_prime/mcp";
const CALL_TIMEOUT_MS = 30_000;
const MAX_RESULTS = 8;
const MAX_SNIPPET_CHARS = 500;

export async function searchZai(
  query: string,
  opts: { recency?: Recency; domain?: string; location?: "cn" | "us" } = {},
): Promise<WebResult<SearchResults>> {
  const key = process.env.ZAI_API_KEY;
  if (!key) {
    return {
      ok: false,
      code: "not-configured",
      message: "web_search needs ZAI_API_KEY (the Z.AI coding-plan key) and it is not set on this server",
    };
  }

  try {
    const init = await mcpPost(key, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "sweatshop", version: "1.0.0" },
      },
    });
    const sessionId = init.response.headers.get("mcp-session-id") ?? undefined;
    await readRpcResult(init.response, 1);

    const call = await mcpPost(key, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "web_search_prime",
        arguments: {
          search_query: query,
          location: opts.location ?? "us",
          content_size: "medium",
          ...(opts.recency && opts.recency !== "noLimit" ? { search_recency_filter: opts.recency } : {}),
          ...(opts.domain ? { search_domain_filter: opts.domain } : {}),
        },
      },
    }, sessionId);
    const result = await readRpcResult(call.response, 2);
    if (result.error) {
      return { ok: false, code: "mcp-error", message: `Search failed: ${result.error}` };
    }
    const payload = result.result as { isError?: boolean; content?: { type?: string; text?: unknown }[] } | undefined;
    const text = payload?.content?.find((c) => c.type === "text")?.text;
    if (typeof text !== "string" || !text.trim()) {
      return { ok: false, code: "bad-response", message: "The search tool returned no readable text" };
    }
    if (payload?.isError) {
      return { ok: false, code: "mcp-error", message: text.slice(0, 300) };
    }
    const hits = parseHits(text);
    if (!hits) {
      return { ok: false, code: "bad-response", message: `Could not parse the search results: ${clipHead(text, 200)}` };
    }
    return { ok: true, query, results: hits.slice(0, MAX_RESULTS).map(clipHit) };
  } catch (err) {
    return {
      ok: false,
      code: "network",
      message: `Search request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** One POST with the right headers; SSE and JSON responses both handled. */
async function mcpPost(
  key: string,
  body: Record<string, unknown>,
  sessionId?: string,
): Promise<{ response: Response }> {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""} from the search endpoint`);
  }
  return { response };
}

/** Pull the JSON-RPC result for `id` out of an SSE or JSON response. */
async function readRpcResult(
  response: Response,
  id: number,
): Promise<{ result?: unknown; error?: string }> {
  const contentType = response.headers.get("content-type") ?? "";
  let messages: unknown[];
  if (contentType.includes("text/event-stream")) {
    messages = parseSseData(await response.text());
  } else {
    messages = [await response.json()];
  }
  const mine = messages.find((m) => (m as { id?: unknown } | null)?.id === id) as
    | { result?: unknown; error?: { message?: unknown } }
    | undefined;
  if (!mine) throw new Error("no JSON-RPC response for the request id");
  if (mine.error) {
    const message = mine.error.message;
    return { error: typeof message === "string" ? message : JSON.stringify(mine.error) };
  }
  return { result: mine.result };
}

function parseSseData(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    out.push(JSON.parse(data));
  }
  return out;
}

/** The double-encoded payload: a JSON string containing the hits array. */
function parseHits(text: string): SearchHit[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  // content[0].text is itself a JSON-encoded string of the array (seen
  // live): parse the inner layer too; a plain array passes through.
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { results?: unknown })?.results)
      ? ((parsed as { results: unknown[] }).results)
      : undefined;
  if (!arr) return undefined;
  const hits: SearchHit[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const title = pickString(o, "title");
    const url = pickString(o, "link", "url");
    const snippet = pickString(o, "content", "snippet");
    if (!title && !url) continue;
    hits.push({ title: title || url || "", url: url || "", snippet: snippet || "" });
  }
  return hits;
}

function pickString(o: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

function clipHit(hit: SearchHit): SearchHit {
  return {
    title: clipHead(hit.title, 300),
    url: hit.url,
    snippet: clipHead(hit.snippet, MAX_SNIPPET_CHARS),
  };
}

