"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

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

  useEffect(() => {
    let cancelled = false;
    let inflight = false;

    const check = async () => {
      if (inflight || document.visibilityState !== "visible") return;
      inflight = true;
      try {
        const res = await fetch("/api/attention", { cache: "no-store" });
        if (!res.ok || cancelled) return;
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

    const timer = setInterval(() => void check(), POLL_MS);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, [rendered, router]);
}
