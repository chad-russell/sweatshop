/**
 * The client's one fetch+parse path: lib/api/* modules own every
 * endpoint's URL, request body and response type (the 0049 read-model
 * rule — components consume typed functions, never raw responses).
 * HTTP errors do NOT throw (callers read `ok`/`status` exactly as they
 * read `res.ok` before); network errors DO reject, like fetch itself,
 * so each call site keeps its own swallow-vs-surface choice — functions
 * that catch for their callers say so in their doc comment.
 */

/** One finished request: `body` is the parsed JSON, null when the
 * response wasn't JSON (the old `.json().catch(() => …)` reads all
 * become optional access on `body`). */
export interface ApiResult<T = unknown> {
  ok: boolean;
  status: number;
  body: T | null;
}

/** fetch + parse. Never throws for an HTTP error status. */
export async function apiFetch<T = unknown>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const res = await fetch(path, init);
  return { ok: res.ok, status: res.status, body: (await res.json().catch(() => null)) as T | null };
}

/** The house error message: the endpoint's `{error}` when it sent one,
 * else `fallback (status)` — the shape every mutation surface used to
 * hand-roll. */
export function apiError(result: ApiResult, fallback: string): string {
  return (result.body as { error?: string } | null)?.error ?? `${fallback} (${result.status})`;
}

/** RequestInit for a JSON request. The content-type header is set only
 * when there IS a body — the endpoints' bodyless DELETEs never sent
 * one, and their wire requests stay byte-identical. */
export function jsonInit(method: string, payload?: unknown): RequestInit {
  return payload === undefined
    ? { method }
    : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) };
}
