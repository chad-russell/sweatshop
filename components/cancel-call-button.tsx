"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

/** The failed-cancel message — `role="alert"` so a screen-reader user is
 *  told the cancel failed, not just left staring at unchanged text.
 *  A plain function (not a hook-bearing component) so it's directly
 *  testable without simulating the click that reaches this state. */
export function CancelErrorMessage({ error }: { error: string }) {
  return (
    <span role="alert" className="text-[10px] text-destructive">
      {error}
    </span>
  );
}

/**
 * 0063: stop a live background harness call (hc_…). Cooperative — the
 * workflow tears its bridge down at its next step boundary, so the copy
 * says so instead of promising an instant kill.
 */
export function CancelCallButton({
  callId,
  label,
  className,
}: {
  callId: string;
  label: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "pending" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const onClick = async () => {
    if (state !== "idle") return;
    const ok = window.confirm(
      `Stop ${label}? It stops at its next step boundary; the sandbox is untouched.`,
    );
    if (!ok) return;
    setState("pending");
    setError(null);
    try {
      const res = await fetch(`/api/x/harness-calls/${encodeURIComponent(callId)}/cancel`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
      if (!res.ok || !body?.ok) {
        setState("error");
        setError(body?.message ?? "failed to cancel");
        return;
      }
      setState("done");
    } catch {
      setState("error");
      setError("failed to cancel");
    }
  };

  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <button
        type="button"
        onClick={onClick}
        disabled={state !== "idle"}
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-60"
      >
        {state === "pending" ? "Stopping…" : "Stop"}
      </button>
      {state === "error" && error && <CancelErrorMessage error={error} />}
    </span>
  );
}
