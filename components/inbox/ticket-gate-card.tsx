"use client";

import { ClipboardCheck } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { NeedsYouTicket } from "@/db/attention";
import { Where } from "./where";

/** A ticket run parked at its plan-approval gate (0004 Path B). */
export function TicketGateCard({
  gate,
  onAnswered,
}: {
  gate: NeedsYouTicket;
  onAnswered: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = async (approved: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tickets/${gate.id}/approval`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approved }),
      });
      if (res.ok) onAnswered(gate.id);
      else {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `Request failed (${res.status})`);
      }
    } catch {
      setError("Network error — is the server up?");
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="flex flex-col gap-3 rounded-lg border border-warning/50 bg-card p-4 text-card-foreground">
      <header className="flex flex-col gap-1">
        <Link
          href={`/t/${gate.id}`}
          className="line-clamp-2 text-sm font-medium hover:underline"
        >
          {gate.ticket}
        </Link>
        <Where projectName={gate.projectName} path={["Ticket run"]} at={gate.since} />
      </header>
      <div className="flex items-start gap-2">
        <ClipboardCheck className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm">Plan ready — approval required before implementation.</p>
          {gate.plan && (
            <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
              {gate.plan}
            </pre>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => void answer(true)}>
          Approve plan
        </Button>
        <Button size="sm" variant="destructive" disabled={busy} onClick={() => void answer(false)}>
          Reject
        </Button>
        <Button asChild size="sm" variant="ghost" className="ml-auto">
          <Link href={`/t/${gate.id}`}>Open run</Link>
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </article>
  );
}
