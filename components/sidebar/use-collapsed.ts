"use client";

import { useCallback, useSyncExternalStore } from "react";

// Folders are expanded by default; only the collapsed ones are stored,
// so a brand-new folder is never hidden. External store over
// localStorage (hydration-safe: the server snapshot is "none collapsed").
const KEY = "sweatshop.sidebar.collapsed";
const EMPTY: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
let cache: { raw: string | null; set: ReadonlySet<string> } | null = null;

function read(): ReadonlySet<string> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return EMPTY;
  }
  if (cache && cache.raw === raw) return cache.set;
  let set: ReadonlySet<string> = EMPTY;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        set = new Set(parsed.filter((v): v is string => typeof v === "string"));
      }
    } catch {
      /* corrupt value — treat as empty */
    }
  }
  cache = { raw, set };
  return set;
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  window.addEventListener("storage", callback);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", callback);
  };
}

export function useCollapsedFolders() {
  const collapsed = useSyncExternalStore(subscribe, read, () => EMPTY);
  const toggle = useCallback((id: string) => {
    const next = new Set(read());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    try {
      localStorage.setItem(KEY, JSON.stringify([...next]));
    } catch {
      /* storage unavailable — state just won't persist */
    }
    for (const listener of listeners) listener();
  }, []);
  return { collapsed, toggle };
}
