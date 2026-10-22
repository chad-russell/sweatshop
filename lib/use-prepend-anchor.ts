"use client";

import { useCallback, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { topInScroller } from "@/lib/anchor-scroll";

/**
 * 0075: keep the viewport pinned while older content is PREPENDED to a
 * use-stick-to-bottom scroller ("Load earlier"). The sentinel row sits
 * at the top of the content; after the prepend commits, scrollTop moves
 * by exactly how far the sentinel moved (the height added above it).
 *
 * Protocol: `capture()` before fetching, then — in the SAME batch as the
 * prepend state update — `commit()`; `cancel()` if nothing is prepended.
 * The pending anchor is tagged with the tick it was captured under and
 * consumed only by the bump that follows it, so content streaming in at
 * the bottom never consumes an anchor. Restores in a layout effect
 * (before paint). Used by the harness session view; written so the chat
 * transcript (components/chat-session.tsx) can adopt it too.
 */
export interface PrependAnchorTarget {
  sentinel: HTMLElement | null;
  scrollRef: MutableRefObject<HTMLElement | null> | null;
}

export function usePrependAnchor(deps: unknown) {
  const targetRef = useRef<PrependAnchorTarget>({ sentinel: null, scrollRef: null });
  const [tick, setTick] = useState(0);
  const pendingRef = useRef<{ sentinelTop: number; scrollTop: number; tick: number } | null>(null);

  const capture = useCallback(() => {
    const { sentinel, scrollRef } = targetRef.current;
    const scroll = scrollRef?.current ?? null;
    pendingRef.current =
      sentinel && scroll
        ? { sentinelTop: topInScroller(scroll, sentinel), scrollTop: scroll.scrollTop, tick }
        : null;
  }, [tick]);
  const commit = useCallback(() => setTick((t) => t + 1), []);
  const cancel = useCallback(() => {
    pendingRef.current = null;
  }, []);

  useLayoutEffect(() => {
    const pending = pendingRef.current;
    if (!pending || pending.tick + 1 !== tick) return;
    pendingRef.current = null;
    const { sentinel, scrollRef } = targetRef.current;
    const scroll = scrollRef?.current ?? null;
    if (!sentinel || !scroll) return;
    scroll.scrollTop = pending.scrollTop + (topInScroller(scroll, sentinel) - pending.sentinelTop);
  }, [tick, deps]);

  return { targetRef, capture, commit, cancel };
}
