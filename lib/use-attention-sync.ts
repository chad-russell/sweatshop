"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { usePollWhileVisible } from "@/lib/use-poll-while-visible";
import { getAttentionSignature } from "@/lib/api/attention";

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
          const signature = await getAttentionSignature();
          if (signature !== null && !stopped.current && signature !== rendered) {
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
