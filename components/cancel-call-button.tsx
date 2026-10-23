"use client";

import { SquareIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
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

type CancelState = "idle" | "pending" | "done" | "error";

/**
 * 0063: stop a live background harness call (hc_…). Cooperative — the
 * workflow tears its bridge down at its next step boundary, so the
 * confirm copy says so instead of promising an instant kill. Shared by
 * the chat card's chip and the session page's stop bar.
 */
function useCancelCall(callId: string, label: string) {
  const [state, setState] = useState<CancelState>("idle");
  const [error, setError] = useState<string | null>(null);

  const cancel = async () => {
    if (state === "pending" || state === "done") return;
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

  return { state, error, cancel };
}

/** The compact chip — the chat's HarnessCard. A failed cancel re-arms it. */
export function CancelCallButton({
  callId,
  label,
  className,
}: {
  callId: string;
  label: string;
  className?: string;
}) {
  const { state, error, cancel } = useCancelCall(callId, label);
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <button
        type="button"
        onClick={() => void cancel()}
        disabled={state === "pending" || state === "done"}
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-60"
      >
        {state === "pending" ? "Stopping…" : "Stop"}
      </button>
      {state === "error" && error && <CancelErrorMessage error={error} />}
    </span>
  );
}

/**
 * The session page's stop bar: sits where the chat composer sits (same
 * width and padding), muted "<label> is working — your chat hears back when it finishes" text plus a square
 * icon button styled like the composer's PromptInputSubmit stop state.
 * A failed cancel re-arms the button so it can be retried.
 */
export function CancelCallBar({ callId, label }: { callId: string; label: string }) {
  const { state, error, cancel } = useCancelCall(callId, label);
  return (
    <div className="w-full px-3 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-4">
      <div className="flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {state === "pending" || state === "done" ? `Stopping ${label}…` : `${label} is working — your chat hears back when it finishes`}
        </span>
        {state === "error" && error && <CancelErrorMessage error={error} />}
        <Button
          type="button"
          size="icon-sm"
          aria-label={`Stop ${label}`}
          onClick={() => void cancel()}
          disabled={state === "pending" || state === "done"}
        >
          {state === "pending" ? <Spinner aria-hidden /> : <SquareIcon className="size-4" />}
        </Button>
      </div>
    </div>
  );
}
