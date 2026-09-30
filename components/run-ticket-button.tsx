"use client";

import { Loader2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

/** Trigger a run_ticket workflow directly from a project page (0004). */
export function RunTicketButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [ticket, setTicket] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startRun = async () => {
    if (!ticket.trim() || starting) return;
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, ticket }),
      });
      if (!res.ok) throw new Error(`trigger failed: ${res.status}`);
      const { ticketId } = (await res.json()) as { ticketId: string };
      router.push(`/t/${ticketId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to start");
      setStarting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex size-8 items-center justify-center rounded-md border border-sidebar-border text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        title="Run a ticket through the pipeline"
        aria-label="Run ticket"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-4" aria-hidden>
          <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4">
          <div className="w-full max-w-lg rounded-lg border border-border bg-card p-4 text-card-foreground shadow-lg">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Run ticket</h2>
              <button
                type="button"
                aria-label="Close"
                onClick={() => !starting && setOpen(false)}
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
            <textarea
              value={ticket}
              onChange={(e) => setTicket(e.target.value)}
              placeholder="Paste the ticket contents…"
              rows={8}
              className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                disabled={starting || !ticket.trim()}
                onClick={() => void startRun()}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-50"
              >
                {starting && <Loader2 className="size-4 animate-spin" />}
                {starting ? "Starting…" : "Run"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
