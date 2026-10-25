"use client";

import { useEffect, useState } from "react";
import type { SearchHit } from "@/lib/read-models/search";
import { searchConversations } from "@/lib/api/search";

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
      searchConversations({ q: trimmed, project, includeArchived }, controller.signal)
        .then((results) => setResults(results))
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
