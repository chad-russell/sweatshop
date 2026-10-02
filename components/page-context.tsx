"use client";

import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { ViewingContext } from "@/lib/page-context";

/**
 * 0015 Part B — the page-context registry. Pages (or server pages, via
 * <PageContextRegistration>) say what they are with usePageContext; the
 * agent panel reads it at send time and turns it into the viewing note.
 *
 * A ref, not state: the context is only read at send time, so updates
 * (a new selection in the machine editor) never re-render anything.
 * Unregistered pages read as { kind: "other", path }.
 */

const PageContextCtx = createContext<{
  /** The registered context (without path — the reader adds it). */
  get: () => Omit<ViewingContext, "path"> | null;
  set: (value: Omit<ViewingContext, "path"> | null) => void;
} | null>(null);

export function PageContextProvider({ children }: { children: ReactNode }) {
  const ref = useRef<Omit<ViewingContext, "path"> | null>(null);
  const value = useMemo(
    () => ({ get: () => ref.current, set: (next: Omit<ViewingContext, "path"> | null) => {
      ref.current = next;
    } }),
    [],
  );
  return <PageContextCtx value={value}>{children}</PageContextCtx>;
}

/** Register what this page is. Re-registers on every render so the
 *  latest title/selection/status is what a send reads. */
export function usePageContext(value: Omit<ViewingContext, "path">) {
  const ctx = useContext(PageContextCtx);
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  });
  useEffect(() => {
    if (!ctx) return;
    ctx.set(valueRef.current);
    return () => ctx.set(null);
  }, [ctx]);
}

/** The panel's reader: call the returned function at SEND time. Pages
 *  that never registered fall back to { kind: "other", path }. */
export function usePageContextReader(): () => ViewingContext {
  const ctx = useContext(PageContextCtx);
  return () => {
    const registered = ctx?.get() ?? null;
    return { kind: "other", ...(registered ?? {}), path: window.location.pathname };
  };
}

/** Server pages say what they are by rendering this (serializable value). */
export function PageContextRegistration({ value }: { value: Omit<ViewingContext, "path"> }) {
  usePageContext(value);
  return null;
}
