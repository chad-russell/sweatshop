"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const DEBOUNCE_MS = 800;

/**
 * 0008: opening a conversation marks it read — but only while you can
 * actually see it (tab visible AND window focused), so a background tab
 * that loads a thread, or a turn finishing behind another window, never
 * counts as reading. `signal` changes whenever new content may have
 * landed (message count, turn status); each change re-marks while
 * watching, so the thread on screen never grows a dot. The sidebar
 * refreshes only when the unread state actually flipped.
 */
export function useMarkSeen(conversationId: string | null, signal: string) {
  const router = useRouter();

  useEffect(() => {
    if (!conversationId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watching = () => document.visibilityState === "visible" && document.hasFocus();

    const mark = () => {
      clearTimeout(timer);
      if (!watching()) return;
      timer = setTimeout(async () => {
        if (!watching()) return;
        try {
          const res = await fetch(`/api/conversations/${conversationId}/seen`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ seen: true }),
          });
          if (!res.ok) return; // not mirrored yet — the next signal retries
          const body = (await res.json()) as { changed?: boolean };
          if (body.changed) router.refresh();
        } catch {
          /* transient — the next signal retries */
        }
      }, DEBOUNCE_MS);
    };

    mark();
    window.addEventListener("focus", mark);
    document.addEventListener("visibilitychange", mark);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", mark);
      document.removeEventListener("visibilitychange", mark);
    };
  }, [conversationId, signal, router]);
}
