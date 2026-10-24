"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { usePollWhileVisible } from "@/lib/use-poll-while-visible";

const POLL_MS = 5000;

/**
 * 0008: keep the server-rendered shell (sidebar dots, Inbox badge, the
 * /inbox page) live. While the tab is visible, poll the tiny
 * /api/attention endpoint and `router.refresh()` only when its signature
 * differs from `rendered` — the signature the layout last rendered —
 * so an idle tick costs one small query and no re-render. Hidden tabs
 * don't poll; coming back (visibility/focus) checks immediately.
 */
export function useAttentionSync(rendered: string) {
  const router = useRouter();

  const makeCheck = useCallback(
    (stopped: { current: boolean }) => {
      let inflight = false;
      return async () => {
        if (inflight || stopped.current) return;
        inflight = true;
        try {
          const res = await fetch("/api/attention", { cache: "no-store" });
          if (!res.ok || stopped.current) return;
          const body = (await res.json()) as { signature?: string };
          if (typeof body.signature === "string" && body.signature !== rendered) {
            router.refresh();
          }
        } catch {
          /* transient — the next tick retries */
        } finally {
          inflight = false;
        }
      };
    },
    [rendered, router],
  );

  usePollWhileVisible(makeCheck, POLL_MS, { focus: true });
}
