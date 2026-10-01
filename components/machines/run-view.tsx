"use client";

import { Bot, CircleCheck, CircleDot, CircleX, Hand, Loader2, MessageSquare, PauseCircle, Terminal } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { Badge } from "@/components/ui/badge";
import type { MachineStageRun } from "@/db/schema";
import type { RunView as Run } from "@/db/machines";
import { cn } from "cn";
import { GateAnswer } from "./gate-answer";

const TERMINAL = new Set(["completed", "failed", "cancelled", "needs-attention"]);

const RUN_TONE: Record<string, string> = {
  running: "text-info",
  waiting: "text-warning",
  "needs-attention": "text-warning",
  completed: "text-success",
  failed: "text-destructive",
  cancelled: "text-muted-foreground",
};

/** Live view of one machine run (0009): stage timeline + inline gate. */
export function MachineRunView({
  initialRun,
  initialVisits,
  projectName,
}: {
  initialRun: Run;
  initialVisits: MachineStageRun[];
  projectName: string | null;
}) {
  const [run, setRun] = useState(initialRun);
  const [visits, setVisits] = useState(initialVisits);

  useEffect(() => {
    if (TERMINAL.has(run.status)) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/machine-runs/${run.id}`, { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { run: Run; visits: MachineStageRun[] };
        setRun(body.run);
        setVisits(body.visits);
      } catch {
        /* transient — keep polling */
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [run.id, run.status]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-lg font-semibold">{run.machineName}</h1>
          <span className={cn("flex items-center gap-1.5 font-mono text-sm", RUN_TONE[run.status])}>
            {!TERMINAL.has(run.status) && run.status !== "waiting" && (
              <Loader2 className="size-3.5 animate-spin" />
            )}
            {run.status}
          </span>
        </div>
        <p className="flex flex-wrap gap-x-3 font-mono text-xs text-muted-foreground">
          <span>{run.id}</span>
          <span>v{run.machineVersion}</span>
          <span>{projectName ?? (run.projectId ? run.projectId : "no workspace")}</span>
          {run.machineId && (
            <Link href={`/machines/${run.machineId}`} className="underline-offset-2 hover:underline">
              edit machine
            </Link>
          )}
        </p>
        {run.error && (
          <p role="alert" className="rounded-md border border-warning/50 bg-card p-2 text-sm text-warning">
            {run.error}
          </p>
        )}
      </header>

      <section className="rounded-lg border border-border bg-card p-4 text-card-foreground">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Prompt</h2>
        <p className="mt-2 text-sm whitespace-pre-wrap">{run.prompt}</p>
      </section>

      <ol className="flex flex-col gap-3">
        {visits.map((visit) => (
          <StageCard key={visit.seq} run={run} visit={visit} />
        ))}
        {visits.length === 0 && (
          <li className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {run.projectId ? "Provisioning the sandbox…" : "Starting…"}
          </li>
        )}
      </ol>
    </div>
  );
}

function StageCard({ run, visit }: { run: Run; visit: MachineStageRun }) {
  const stage = run.definition.stages[visit.stageId];
  const KindIcon = visit.kind === "harness" ? Terminal : visit.kind === "agent" ? Bot : Hand;
  const waitingGate = visit.kind === "human" && visit.status === "waiting" && run.status === "waiting";
  const link =
    visit.kind === "harness" && visit.harness && visit.sessionId
      ? { href: `/h/${visit.harness}/${visit.sessionId}`, label: `${visit.harness} session` }
      : visit.kind === "agent" && visit.sessionId
        ? { href: `/c/${visit.sessionId}`, label: "conversation" }
        : null;

  return (
    <li
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground",
        waitingGate && "border-warning/60",
      )}
    >
      <header className="flex items-center gap-2">
        <StatusIcon status={visit.status} />
        <KindIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">{stage?.title ?? visit.stageId}</span>
        <Badge variant="outline" className="font-mono">
          {visit.kind === "harness" ? visit.harness : visit.kind}
        </Badge>
        <span className="ml-auto flex items-center gap-3 font-mono text-xs text-muted-foreground">
          {visit.kind === "harness" && visit.steps > 0 && <span>{visit.steps} steps</span>}
          {visit.transitionTo && <span>→ {visit.transitionTo}</span>}
          {link && (
            <Link href={link.href} className="flex items-center gap-1 underline-offset-2 hover:underline">
              <MessageSquare className="size-3" />
              {link.label}
            </Link>
          )}
        </span>
      </header>
      {visit.error && <p className="text-sm text-warning">{visit.error}</p>}
      {visit.outcome && (
        <div className="max-h-96 overflow-auto text-sm">
          {visit.kind === "human" ? (
            <p className="whitespace-pre-wrap text-muted-foreground">“{visit.outcome}”</p>
          ) : (
            <MessageResponse>{visit.outcome}</MessageResponse>
          )}
        </div>
      )}
      {waitingGate && stage && (
        <>
          {stage.instructions && <p className="text-sm">{stage.instructions}</p>}
          <GateAnswer runId={run.id} seq={visit.seq} targets={stage.next} />
        </>
      )}
    </li>
  );
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return <CircleCheck className="size-4 shrink-0 text-success" />;
    case "failed":
      return <CircleX className="size-4 shrink-0 text-destructive" />;
    case "parked":
      return <PauseCircle className="size-4 shrink-0 text-warning" />;
    case "waiting":
      return <CircleDot className="size-4 shrink-0 text-warning" />;
    default:
      return <Loader2 className="size-4 shrink-0 animate-spin text-info" />;
  }
}
