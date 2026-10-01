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
        </div>
      </div>
      <GateAnswer runId={gate.runId} seq={gate.seq} targets={gate.targets} onAnswered={() => onAnswered(gate.id)} />
      <Button asChild size="sm" variant="ghost" className="self-end">
        <Link href={`/r/${gate.runId}`}>Open run</Link>
      </Button>
    </article>
  );
}
