"use client";

import { useEffect, useRef, useState } from "react";

const POLL_MS = 5000;

/**
 * 0052: a PR's live lifecycle state — the client-side copy of the seam
 * type, defined locally so this lib stays client-safe.
 */
export interface PRStateInfo {
  state: "open" | "merged" | "closed";
  mergedAt?: string;
}

/** A settled PR (merged/closed) is done — never fetched again. */
export function isSettled(state: PRStateInfo | null | undefined): boolean {
  return state?.state === "merged" || state?.state === "closed";
}

/** The poll-stop rule (pure, for tests): polling may stop once every
 *  tracked URL's known state is settled; unknown (null) keeps polling. */
export function pollSettled(
  states: readonly (PRStateInfo | null | undefined)[],
): boolean {
  return states.length > 0 && states.every(isSettled);
}

/**
 * Live states for a set of PR web URLs (0052): fetched once on change,
 * then polled every 5 s while the tab is visible — the useChildStatus
 * rule — until every tracked PR is settled, then stopped for good (a
 * settled PR is never refetched; unknown keeps polling). `urls` null =
 * nothing to watch. Returns `{ [url]: state | null }`; entries appear
 * as answers land.
 */
export function usePRStates(
  urls: readonly string[] | null,
): Record<string, PRStateInfo | null> {
  // A stable key from the urls: array identity churn (a new array every
  // render) must not retrigger the effect — same set, same key.
  const key = urls === null || urls.length === 0 ? "" : [...urls].sort().join("\n");
  const [states, setStates] = useState<Record<string, PRStateInfo | null>>({});
  const latest = useRef(states);
  useEffect(() => {
    latest.current = states;
  }, [states]);

  useEffect(() => {
    if (!key) return;
    const tracked = key.split("\n");
    let stop = false;
    let busy = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const finish = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
        document.removeEventListener("visibilitychange", check);
      }
    };
    const check = async () => {
      if (stop || busy || document.visibilityState !== "visible") return;
      const pending = tracked.filter((url) => !isSettled(latest.current[url]));
      if (pending.length === 0) {
        finish();
        return;
      }
      busy = true;
      try {
        const query = pending.map((url) => `url=${encodeURIComponent(url)}`).join("&");
        const res = await fetch(`/api/x/prs?${query}`, { cache: "no-store" });
        if (!res.ok || stop) return;
        const body = (await res.json()) as Record<string, PRStateInfo | null>;
        latest.current = { ...latest.current, ...body };
        setStates(latest.current);
        if (pollSettled(tracked.map((url) => latest.current[url]))) finish();
      } catch {
        /* transient — the next tick retries */
      } finally {
        busy = false;
      }
    };

    void check();
    timer = setInterval(() => void check(), POLL_MS);
    document.addEventListener("visibilitychange", check);
    return () => {
      stop = true;
      finish();
    };
  }, [key]);

  return states;
}
