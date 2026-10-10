"use client";

import { Workflow } from "lucide-react";
import Link from "next/link";
import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { GateAnswer } from "@/components/machines/gate-answer";
import type { NeedsYouMachineGate } from "@/db/attention";
import { Where } from "./where";

/** A machine run waiting at a human stage (0009). */
export function MachineGateCard({
  gate,
  onAnswered,
}: {
  gate: NeedsYouMachineGate;
  onAnswered: (id: string) => void;
}) {
  return (
    <article className="flex flex-col gap-3 rounded-lg border border-warning/50 bg-card p-4 text-card-foreground">
      <header className="flex flex-col gap-1">
        <Link href={`/r/${gate.runId}`} className="line-clamp-2 text-sm font-medium hover:underline">
          {gate.machineName}: {gate.stageTitle}
        </Link>
        <Where projectName={gate.projectName} path={["Machine run"]} at={gate.since} />
      </header>
      <div className="flex items-start gap-2">
        <Workflow className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="line-clamp-2 text-xs text-muted-foreground">{gate.prompt}</p>
          {gate.instructions && <p className="text-sm">{gate.instructions}</p>}
          {gate.lastOutcome && (
            <div className="max-h-56 overflow-auto rounded-md bg-muted p-2 text-sm">
              <MessageResponse>{gate.lastOutcome}</MessageResponse>
            </div>
          )}
          {gate.evidence && gate.evidence.length > 0 && (
            <div className="grid grid-cols-3 gap-1">
              {gate.evidence.map((e, i) => (
                <a key={i} href={e.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md border border-border">
                  {/* eslint-disable-next-line @next/next/no-img-element -- immutable attachment files served by our API */}
                  <img src={e.url} alt={e.label ?? "attached screenshot"} className="h-28 w-full object-cover object-top hover:opacity-80" />
                </a>
              ))}
            </div>
          )}
          {gate.prProposal && (
            <div className="max-h-72 space-y-1 overflow-auto rounded-md border border-primary/40 p-2">
              <p className="text-xs font-medium text-primary">
                PR — {gate.prProposal.head} → {gate.prProposal.base ?? "main"} on {gate.prProposal.repo}
              </p>
              <pre className="whitespace-pre-wrap font-mono text-xs text-muted-foreground">
                {gate.prProposal.summary}
              </pre>
              <p className="text-xs text-muted-foreground">
                Approving sends this to the run&apos;s Publish stage: it pushes the branch and opens the PR.
              </p>
            </div>
          )}
        </div>
      </div>
      <GateAnswer runId={gate.runId} seq={gate.seq} targets={gate.targets} onAnswered={() => onAnswered(gate.id)} />
      <Button asChild size="sm" variant="ghost" className="self-end">
        <Link href={`/r/${gate.runId}`}>Open run</Link>
      </Button>
    </article>
  );
}
