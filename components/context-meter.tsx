"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * 0051: the chat-header context meter. The PERCENTAGE leads (Chad's
 * call): "oops, context is at 80% — wrap this up." A thin bar shows the
 * fraction; neutral below 85%, warning 85–94, destructive at 95+. The
 * reading is the conversation's last metered turn (the last slice's
 * input+output vs the model's window). Hidden until the chat has
 * metered turns (forward-only, per 0047).
 *
 * Refresh: re-fetch on turn settle (busy → idle), not on a timer — the
 * row is written at turn end, so a mid-turn poll would show stale data.
 */

interface ContextStats {
  usedTokens: number;
  windowTokens: number;
  pct: number;
}

type StatsPayload = { context: ContextStats | null };

function formatTokens(n: number): string {
  if (n >= 100_000) return `${Math.round(n / 1000)}k`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString("en-US");
}

export function ContextMeter({
  conversationId,
  busy,
  started,
}: {
  conversationId: string;
  /** True while a turn runs — the settle edge triggers a re-fetch. */
  busy: boolean;
  /** Hidden until the conversation exists server-side. */
  started: boolean;
}) {
  const [context, setContext] = useState<ContextStats | null>(null);

  useEffect(() => {
    if (!started) return;
    let cancel = false;
    fetch(`/api/x/stats/${conversationId}`)
      .then(async (res) => (res.ok ? ((await res.json()) as StatsPayload) : null))
      .then((body) => {
        if (!cancel) setContext(body?.context ?? null);
      })
      .catch(() => {
        /* the chip stays hidden on error — never blocks the header */
      });
    return () => {
      cancel = true;
    };
    // busy is a deliberate non-dep: it only triggers the effect's edge
    // (busy → idle), the fetch itself always reads current data.
  }, [started, conversationId, busy]);

  if (!context || context.windowTokens <= 0) return null;
  const pct = Math.round(context.pct * 100);
  const bar =
    pct >= 95 ? "bg-destructive" : pct >= 85 ? "bg-warning" : "bg-primary/60";

  return (
    <span
      className="inline-flex h-8 shrink-0 items-center gap-2 rounded-lg border px-2.5 text-sm"
      title={`Context: ${context.usedTokens.toLocaleString("en-US")} of ${context.windowTokens.toLocaleString("en-US")} tokens (${pct}%) — the conversation's size after its last turn`}
    >
      <span className="font-mono tabular-nums">{pct}%</span>
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-muted" aria-hidden>
        <span
          className={cn("block h-full rounded-full transition-[width]", bar)}
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </span>
      <span className="hidden text-xs text-muted-foreground sm:inline font-mono tabular-nums">
        {formatTokens(context.usedTokens)}/{formatTokens(context.windowTokens)}
      </span>
    </span>
  );
}
