/**
 * 0016: the sidebar's conversation search. HTTP failures are null (the
 * palette clears to no results); network errors — including the
 * debouncer's abort — reject so the caller keeps the last results.
 */

import type { SearchHit } from "@/lib/read-models/search";
import { apiFetch } from "./core";

/** Search conversations by prefix query, project-scoped, archived
 * opt-in. The signal is the debouncer's abort controller's. */
export async function searchConversations(
  scope: { q: string; project?: string; includeArchived: boolean },
  signal: AbortSignal,
): Promise<SearchHit[] | null> {
  const params = new URLSearchParams({ q: scope.q });
  if (scope.project) params.set("project", scope.project);
  if (!scope.includeArchived) params.set("archived", "0");
  const res = await apiFetch<{ results?: SearchHit[] }>(`/api/search?${params}`, { signal });
  return res.ok ? (res.body?.results ?? []) : null;
}
