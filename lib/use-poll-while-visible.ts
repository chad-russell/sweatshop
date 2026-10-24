"use client";

import { useEffect } from "react";

/**
 * 0008: the shared client poller plumbing — an interval tick plus a
 * visibilitychange listener, both tearing down together. Replaces the
 * hand-rolled copies in use-attention-sync.ts and use-child-status.ts
 * (and matches the 5 s wake/status polls' rule elsewhere): the timer
 * always runs, but each tick no-ops while the tab is hidden, and coming
 * back visible checks immediately.
 */

/**
 * A per-activation flag cell the poller hands to the check it runs:
 * flipped to true on teardown, so a response from an in-flight check of
 * a dead activation (the id changed, the component unmounted) never
 * touches state. Same role as the `stop`/`cancelled` lets the inline
 * effects used to close over.
 */
export interface PollStopFlag {
  current: boolean;
}

/** Build one activation's check from its per-activation stop flag. */
export type PollCheckFactory = (stopped: PollStopFlag) => () => void | Promise<void>;

export interface PollWhileVisibleOptions {
  /** Run one check the moment the poll activates (useChildStatus does;
   *  the attention poll waits for its first tick). */
  immediate?: boolean;
  /** Also re-check on window focus — the shell poll's comeback path
   *  when only the window (not the tab's visibility) changed. */
  focus?: boolean;
}

/**
 * Poll `makeCheck` every `ms` while the tab is visible. `makeCheck` is
 * invoked once per activation (not per tick) so its closure owns
 * per-activation state (inflight/live flags) exactly like the inline
 * effects this replaces — memoize it (useCallback) on whatever should
 * restart the poll, and pass null to park it (nothing to poll).
 */
export function usePollWhileVisible(
  makeCheck: PollCheckFactory | null,
  ms: number,
  { immediate = false, focus = false }: PollWhileVisibleOptions = {},
): void {
  useEffect(() => {
    if (!makeCheck) return;
    const stopped: PollStopFlag = { current: false };
    const check = makeCheck(stopped);
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void check();
    };
    if (immediate) tick();
    const timer = setInterval(tick, ms);
    document.addEventListener("visibilitychange", tick);
    if (focus) window.addEventListener("focus", tick);
    return () => {
      stopped.current = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      if (focus) window.removeEventListener("focus", tick);
    };
  }, [makeCheck, ms, immediate, focus]);
}
