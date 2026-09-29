"use client";

import { useSyncExternalStore } from "react";

const emptySubscribe = () => () => {};

/**
 * Hydration-safe mounted gate without setState-in-effect: the client
 * snapshot flips to true after hydration, the server snapshot stays
 * false. Use for anything whose client-only value (localStorage, live
 * agent status, browser locale) would mismatch server-rendered HTML.
 */
export function useMounted(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}
