"use client";

import { useEffect, useState } from "react";
import type { SearchHit } from "@/lib/read-models/search";

export interface SearchScope {
  /** Project id, "none" for Chats, undefined for everywhere. */
  project?: string;
  includeArchived: boolean;
}

/** Debounced search over the store (0003/0007); null until results land. */
export function useConversationSearch(
  query: string,
  scope: SearchScope,
): SearchHit[] | null {
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const { project, includeArchived } = scope;

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: trimmed });
      if (project) params.set("project", project);
      if (!includeArchived) params.set("archived", "0");
      fetch(`/api/search?${params}`, { signal: controller.signal })
        .then(async (res) => {
          if (res.ok) return (await res.json()) as { results: SearchHit[] };
          return { results: [] };
        })
        .then((body) => setResults(body.results))
        .catch(() => {
          /* aborted or offline — keep the last results */
        });
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, project, includeArchived]);

  return results;
}
