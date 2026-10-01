"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Client side of the 0007 organization API. Every action resolves to
 * whether it succeeded; failures surface as a short-lived `error`
 * string (the server enforces all invariants — the UI only mirrors
 * them to disable invalid drop targets). Success refreshes the server-
 * rendered layout, which re-reads the store.
 */
export function useSidebarActions() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(timer);
  }, [error]);

  const call = useCallback(
    async (method: string, url: string, body?: unknown): Promise<boolean> => {
      try {
        const res = await fetch(url, {
          method,
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          setError(payload?.error ?? `Request failed (${res.status})`);
          return false;
        }
        setError(null);
        router.refresh();
        return true;
      } catch {
        setError("Network error — is the server up?");
        return false;
      }
    },
    [router],
  );

  return useMemo(
    () => ({
      error,
      clearError: () => setError(null),
      createFolder: (name: string, projectId: string | null, parentId: string | null) =>
        call("POST", "/api/folders", { name, projectId, parentId }),
      renameFolder: (id: string, name: string) =>
        call("PATCH", `/api/folders/${id}`, { name }),
      moveFolder: (id: string, parentId: string | null) =>
        call("PATCH", `/api/folders/${id}`, { parentId }),
      deleteFolder: (id: string) => call("DELETE", `/api/folders/${id}`),
      moveConversation: (id: string, folderId: string | null) =>
        call("PATCH", `/api/conversations/${id}`, { folderId }),
      renameConversation: (id: string, title: string) =>
        call("PATCH", `/api/conversations/${id}`, { title }),
      setArchived: (id: string, archived: boolean) =>
        call("PATCH", `/api/conversations/${id}`, { archived }),
      setTrashed: (id: string, trashed: boolean) =>
        call("PATCH", `/api/conversations/${id}`, { trashed }),
      deleteForever: (id: string) => call("DELETE", `/api/conversations/${id}`),
    }),
    [call, error],
  );
}

export type SidebarActions = ReturnType<typeof useSidebarActions>;
