"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { deleteConversation, updateConversation } from "@/lib/api/conversations";
import { createFolder, deleteFolder, updateFolder } from "@/lib/api/folders";
import { apiError, type ApiResult } from "@/lib/api/core";

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
    async (op: () => Promise<ApiResult>): Promise<boolean> => {
      try {
        const res = await op();
        if (!res.ok) {
          setError(apiError(res, "Request failed"));
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
        call(() => createFolder(name, projectId, parentId)),
      renameFolder: (id: string, name: string) =>
        call(() => updateFolder(id, { name })),
      moveFolder: (id: string, parentId: string | null) =>
        call(() => updateFolder(id, { parentId })),
      deleteFolder: (id: string) => call(() => deleteFolder(id)),
      moveConversation: (id: string, folderId: string | null) =>
        call(() => updateConversation(id, { folderId })),
      renameConversation: (id: string, title: string) =>
        call(() => updateConversation(id, { title })),
      setArchived: (id: string, archived: boolean) =>
        call(() => updateConversation(id, { archived })),
      setTrashed: (id: string, trashed: boolean) =>
        call(() => updateConversation(id, { trashed })),
      deleteForever: (id: string) => call(() => deleteConversation(id)),
    }),
    [call, error],
  );
}

export type SidebarActions = ReturnType<typeof useSidebarActions>;
