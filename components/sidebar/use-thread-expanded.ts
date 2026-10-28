"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * 0040 phase 2: explicit expand/collapse choices for parent conversation
 * rows — TRI-state: a parent's default comes from its live status
 * (lib/sidebar-tree.ts defaultExpanded), so "no entry here" must mean
 * "use that default", not "open" or "closed". Same external-store-over-
 * localStorage pattern as use-preferences.ts (hydration-safe: the
 * server snapshot is "no explicit choices").
 */
const KEY = "sweatshop.sidebar.thread-expanded";
const EMPTY: ReadonlyMap<string, boolean> = new Map();
const listeners = new Set<() => void>();
let cache: { raw: string | null; map: ReadonlyMap<string, boolean> } | null = null;

function read(): ReadonlyMap<string, boolean> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return EMPTY;
  }
  if (cache && cache.raw === raw) return cache.map;
  let map: ReadonlyMap<string, boolean> = EMPTY;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        map = new Map(
          Object.entries(parsed as Record<string, unknown>).filter(
            (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
          ),
        );
      }
    } catch {
      /* corrupt value — treat as empty */
    }
  }
  cache = { raw, map };
  return map;
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  window.addEventListener("storage", callback);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", callback);
  };
}

export function useThreadExpanded() {
  const explicit = useSyncExternalStore(subscribe, read, () => EMPTY);
  const setExpanded = useCallback((id: string, expanded: boolean) => {
    const next = new Map(read());
    next.set(id, expanded);
    try {
      localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(next)));
    } catch {
      /* storage unavailable — state just won't persist */
    }
    for (const listener of listeners) listener();
  }, []);
  return { explicit, setExpanded };
}
