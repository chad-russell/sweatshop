"use client";

import { useEffect, useRef, useState } from "react";
import type { MachineDefinition } from "@/lib/machines/definition";

const POLL_MS = 5000;

export interface MachineSnapshot {
  name: string;
  description: string;
  definition: MachineDefinition;
  version: number;
}

export type MachineSyncState =
  | { state: "current" }
  /** The saved machine moved on and the editor has unsaved edits. */
  | { state: "stale"; version: number }
  /** The machine was deleted elsewhere. */
  | { state: "gone" };

/**
 * 0015 Phase 2 — the editor's side of "the agent edits through the same
 * ops". While the tab is visible, poll the machine's version every 5 s:
 *
 *  - saved version moved on and the editor is clean → adopt the saved
 *    machine silently (onAdopt): when the panel edits the machine you
 *    are looking at, you see it land.
 *  - moved on with unsaved edits → never clobber; surface `stale` so
 *    the editor can offer "Reload (discard your changes)".
 *
 * Hidden tabs don't poll; coming back (visibility/focus) checks
 * immediately — the same shape as useAttentionSync.
 */
export function useMachineVersionSync(options: {
  /** Null while creating (no id yet) — no polling. */
  id: string | null;
  /** The version this editor's draft is based on (the base it adopted). */
  baseVersion: number;
  /** True when the editor holds unsaved edits (including unparsed JSON text). */
  dirty: boolean;
  onAdopt: (snapshot: MachineSnapshot) => void;
}): { sync: MachineSyncState; reload: () => Promise<void> } {
  const { id, baseVersion, dirty, onAdopt } = options;
  // Latest values for the interval callback (compiler-safe ref updates).
  const dirtyRef = useRef(dirty);
  const onAdoptRef = useRef(onAdopt);
  useEffect(() => {
    dirtyRef.current = dirty;
    onAdoptRef.current = onAdopt;
  }, [dirty, onAdopt]);
  const [sync, setSync] = useState<MachineSyncState>({ state: "current" });
  const inflight = useRef(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    const check = async () => {
      if (inflight.current || document.visibilityState !== "visible") return;
      inflight.current = true;
      try {
        const res = await fetch(`/api/machines/${id}`, { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 404) {
          setSync({ state: "gone" });
          return;
        }
        if (!res.ok) return; // transient — the next tick retries
        const body = (await res.json()) as { machine?: MachineSnapshot & { id: string } };
        const machine = body.machine;
        if (!machine || machine.version <= baseVersion) return;
        if (dirtyRef.current) {
          setSync({ state: "stale", version: machine.version });
        } else {
          onAdoptRef.current(machine);
          setSync({ state: "current" });
        }
      } catch {
        /* transient — the next tick retries */
      } finally {
        inflight.current = false;
      }
    };

    const timer = setInterval(() => void check(), POLL_MS);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, [id, baseVersion]);

  /** The stale banner's "Reload (discard your changes)": fetch and adopt. */
  const reload = async () => {
    if (!id) return;
    const res = await fetch(`/api/machines/${id}`, { cache: "no-store" });
    if (!res.ok) return;
    const body = (await res.json()) as { machine?: MachineSnapshot & { id: string } };
    if (!body.machine) return;
    onAdoptRef.current(body.machine);
    setSync({ state: "current" });
  };

  return { sync, reload };
}
