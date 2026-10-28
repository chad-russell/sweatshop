"use client";

import { useCallback, useSyncExternalStore } from "react";

// Whether the conversation sidebar is collapsed off-screen on md+ (the
// toggle button in its header, and NavTrigger reappearing to expand it —
// see nav-drawer.tsx). Expanded by default; hydration-safe external
// store over localStorage (the server snapshot is "expanded"), same
// pattern as use-thread-expanded.ts for conversation rows.
const KEY = "sweatshop.sidebar.hidden";
const listeners = new Set<() => void>();
let cache: { raw: string | null; value: boolean } | null = null;

function read(): boolean {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return false;
  }
  if (cache && cache.raw === raw) return cache.value;
  const value = raw === "1";
  cache = { raw, value };
  return value;
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  window.addEventListener("storage", callback);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", callback);
  };
}

export function useSidebarCollapsed() {
  const collapsed = useSyncExternalStore(subscribe, read, () => false);
  const setCollapsed = useCallback((next: boolean) => {
    try {
      if (next) localStorage.setItem(KEY, "1");
      else localStorage.removeItem(KEY);
    } catch {
      /* storage unavailable — state just won't persist */
    }
    for (const listener of listeners) listener();
  }, []);
  return { collapsed, setCollapsed };
}
