"use client";

import { useSyncExternalStore } from "react";
import { DEFAULT_SIDEBAR_PREFERENCES, parseSidebarPreferences, type SidebarPreferences } from "@/lib/sidebar-organization";

const KEY = "sweatshop.sidebar.preferences";
const LEGACY_KEY = "sweatshop.sidebar.collapsed";

/** In-memory state remains usable even if localStorage is blocked or full. */
export function createSidebarPreferenceStore(storage: () => Pick<Storage, "getItem" | "setItem">) {
  const listeners = new Set<() => void>();
  let snapshot = DEFAULT_SIDEBAR_PREFERENCES;
  let source: string | undefined;
  let memoryOnly = false;
  const read = () => {
    if (memoryOnly) return snapshot;
    try {
      const local = storage();
      const raw = local.getItem(KEY);
      const legacy = local.getItem(LEGACY_KEY);
      const nextSource = JSON.stringify([raw, legacy]);
      if (source !== nextSource) {
        snapshot = parseSidebarPreferences(raw, legacy);
        source = nextSource;
      }
    } catch { memoryOnly = true; }
    return snapshot;
  };
  const update = (change: (current: SidebarPreferences) => SidebarPreferences) => {
    const next = change(read());
    if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
    snapshot = next;
    try {
      const local = storage();
      const raw = JSON.stringify(next);
      local.setItem(KEY, raw);
      source = JSON.stringify([raw, local.getItem(LEGACY_KEY)]);
    } catch { memoryOnly = true; }
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === KEY || event.key === LEGACY_KEY) listener();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener("storage", onStorage);
    };
  };
  return { read, update, subscribe };
}

const store = createSidebarPreferenceStore(() => localStorage);
export function useSidebarPreferences() {
  const preferences = useSyncExternalStore(store.subscribe, store.read, () => DEFAULT_SIDEBAR_PREFERENCES);
  return { preferences, updatePreferences: store.update };
}
