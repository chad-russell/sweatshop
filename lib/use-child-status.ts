"use client";

import { useCallback, useState } from "react";
import type { ChildStatus } from "@/lib/child-status";
import { usePollWhileVisible } from "@/lib/use-poll-while-visible";
import { getChildStatus } from "@/lib/api/status";

const POLL_MS = 5000;

/**
 * Live status for a transcript card's background child (hc_… / c_…):
 * fetched once, then polled every 5 s while the child is live AND the tab
 * is visible (the 0008 attention poll's rule); a settled child is never
 * fetched again. `id` null = nothing started (or not yet).
 */
export function useChildStatus(id: string | null): ChildStatus | null {
  const [status, setStatus] = useState<ChildStatus | null>(null);

  const makeCheck = useCallback(
    (stopped: { current: boolean }) => {
      let live = true;
      return async () => {
        if (!live || stopped.current || !id) return;
        const next = await getChildStatus(id);
        if (!next) return;
        live = next.live;
        setStatus(next);
      };
    },
    [id],
  );

  usePollWhileVisible(id ? makeCheck : null, POLL_MS, { immediate: true });

  return id && status?.id === id ? status : null;
}

/** "42s", "3m 05s", "1h 02m" — how long a child ran (or has been running). */
export function elapsed(from: number, to: number): string {
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
