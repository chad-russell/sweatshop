"use client";

import { useSyncExternalStore } from "react";

const noSubscribe = () => () => {};
/** The visitor's clock, as a snapshot: null on the server and during hydration. */
function useClientNow(): number | null {
  // Rounded to the minute so the snapshot is stable between renders
  // (useSyncExternalStore requires getSnapshot to return a cached value).
  return useSyncExternalStore(
    noSubscribe,
    () => Math.floor(Date.now() / 60_000) * 60_000,
    () => null,
  );
}

/** "just now" / "5m ago" / "3h ago" / "Oct 2" — relative to the visitor's clock. */
function relative(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * A timestamp rendered in the visitor's clock and locale. The server
 * (UTC, different "now") cannot predict either, so it renders an empty
 * placeholder and the text appears once mounted (see use-mounted).
 */
export function LocalTime({ ms, className }: { ms: number; className?: string }) {
  const now = useClientNow();
  return (
    <time
      dateTime={new Date(ms).toISOString()}
      title={now !== null ? new Date(ms).toLocaleString() : undefined}
      className={className}
    >
      {now !== null ? relative(ms, now) : "\u00a0"}
    </time>
  );
}
