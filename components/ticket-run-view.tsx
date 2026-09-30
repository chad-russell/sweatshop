"use client";

import { Check, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";

interface RunRow {
  id: string;
  projectId: string;
  ticket: string;
  status: string;
  detail: string | null;
  branch: string | null;
  prUrl: string | null;
}

const TERMINAL = new Set(["completed", "rejected", "failed"]);

/** Live view of one ticket run: status polling + the approval gate. */
export function TicketRunView({ initial }: { initial: RunRow }) {
  const [run, setRun] = useState(initial);
  const [answering, setAnswering] = useState(false);

  useEffect(() => {
    if (TERMINAL.has(run.status)) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/tickets/${run.id}`, { cache: "no-store" });
        if (res.ok) {
          const body = (await res.json()) as { run: RunRow };
          setRun(body.run);
        }
      } catch {
        /* transient — keep polling */
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [run.id, run.status]);

  const answer = async (approved: boolean) => {
    setAnswering(true);
    try {
      await fetch(`/api/tickets/${run.id}/approval`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approved }),
      });
    } finally {
      setAnswering(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
      <header className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-sm text-muted-foreground">
          ticket run {run.id}
        </span>
        <span className="font-mono text-sm">
          {!TERMINAL.has(run.status) && (
            <Loader2 className="mr-1 inline size-3.5 animate-spin align-text-bottom" />
          )}
          {run.status}
        </span>
      </header>

      <section className="rounded-lg border border-border bg-card p-4 text-card-foreground">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Ticket
        </h2>
        <pre className="mt-2 whitespace-pre-wrap font-mono text-xs">
          {run.ticket}
        </pre>
      </section>

      {run.status === "awaiting-approval" && (
        <section className="rounded-lg border border-warning bg-card p-4 text-card-foreground">
          <h2 className="text-xs font-medium uppercase tracking-wide text-warning">
            Plan — approval required
          </h2>
          {run.branch && (
            <p className="mt-2 font-mono text-xs text-muted-foreground">
              branch: {run.branch}
            </p>
          )}
          <pre className="mt-2 whitespace-pre-wrap text-sm">
            {run.detail ?? "(no plan text)"}
          </pre>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={answering}
              onClick={() => void answer(true)}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-50"
            >
              <Check className="size-4" /> Approve & implement
            </button>
            <button
              type="button"
              disabled={answering}
              onClick={() => void answer(false)}
              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-accent disabled:opacity-50"
            >
              <X className="size-4" /> Reject
            </button>
          </div>
        </section>
      )}

      {run.detail && run.status !== "awaiting-approval" && (
        <section className="rounded-lg border border-border bg-card p-4 text-card-foreground">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {run.status === "completed" ? "Result" : "Detail"}
          </h2>
          <pre className="mt-2 whitespace-pre-wrap text-sm">{run.detail}</pre>
          {run.prUrl && (
            <a
              href={run.prUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-block rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Open pull request →
            </a>
          )}
        </section>
      )}
    </div>
  );
}
