import { objectOf } from "./fields";
import type { ToolState } from "./inspect";

/**
 * 1.5 (roadmap): normalisers for the web tools' results — the same
 * posture as tool-views/inspect: the tools return value-shaped JSON
 * (`{ok:true,…}` / `{ok:false,code,message}`), and everything here is
 * pure and defensive about stored input/output never trusting fields.
 */

export interface WebFailure {
  code: string;
  message: string;
}

export function webFailureOf(output: unknown): WebFailure | undefined {
  const o = objectOf(output);
  if (!o || o.ok !== false) return undefined;
  return {
    code: typeof o.code === "string" ? o.code : "error",
    message: typeof o.message === "string" ? o.message : "the tool reported a failure",
  };
}

export function webState(part: { state: string }, failed: boolean): ToolState {
  if (failed || part.state === "output-error" || part.state === "output-denied") return "error";
  return part.state === "output-available" ? "completed" : "running";
}

// --- web_search ----------------------------------------------------------------

export interface SearchHitView {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchView {
  query: string;
  hits: SearchHitView[];
}

export function searchView(input: unknown, output: unknown): SearchView | undefined {
  const query = objectOf(input)?.query;
  const results = objectOf(output)?.results;
  const hits: SearchHitView[] = [];
  if (Array.isArray(results)) {
    for (const item of results.slice(0, 12)) {
      const o = objectOf(item);
      if (!o) continue;
      const title = typeof o.title === "string" ? o.title : "";
      const url = typeof o.url === "string" ? o.url : "";
      if (!title && !url) continue;
      hits.push({ title: title || url, url, snippet: typeof o.snippet === "string" ? o.snippet : "" });
    }
  }
  if (typeof query !== "string") return undefined;
  return { query, hits };
}

// --- web_fetch -----------------------------------------------------------------

export interface FetchView {
  url: string;
  finalUrl?: string;
  status?: number;
  contentType?: string;
  bytes?: number;
  title?: string;
  text?: string;
  truncated?: boolean;
  textClipped?: boolean;
}

export function fetchView(input: unknown, output: unknown): FetchView | undefined {
  const url = objectOf(input)?.url;
  if (typeof url !== "string") return undefined;
  const o = objectOf(output) ?? {};
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  return {
    url,
    finalUrl: str(o.finalUrl),
    status: num(o.status),
    contentType: str(o.contentType),
    bytes: num(o.bytes),
    title: str(o.title),
    text: str(o.text),
    truncated: o.truncated === true,
    textClipped: o.textClipped === true,
  };
}

/** "2.4 kB" / "1.1 MB" for a byte count. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** host + path, for a compact card headline: "example.com/docs". */
export function urlHeadline(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}
