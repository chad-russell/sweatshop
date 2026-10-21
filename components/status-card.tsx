"use client";

import { Ban, Check, Circle, CircleDot, Minus } from "lucide-react";
import type { StatusSnapshot, StatusState, StatusStep } from "@/lib/status";
import { isStatusSnapshot } from "@/lib/status";
import { cn } from "@/lib/utils";

/**
 * 0059: the compact transcript card for one `update_status` rewrite.
 * The latest of these IS the thread's status.
 */

const MARK: Record<StatusState, { icon: typeof Check; className: string; label: string }> = {
  done: { icon: Check, className: "text-success", label: "done" },
  active: { icon: CircleDot, className: "text-info", label: "active" },
  pending: { icon: Circle, className: "text-muted-foreground", label: "pending" },
  skipped: { icon: Minus, className: "text-muted-foreground", label: "skipped" },
  blocked: { icon: Ban, className: "text-warning", label: "blocked" },
};

function StepRow({ step, nested }: { step: StatusStep; nested?: boolean }) {
  const mark = MARK[step.state];
  const Icon = mark.icon;
  return (
    <li className={cn("flex items-start gap-1.5 py-0.5 text-sm", nested && "pl-5")}>
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", mark.className)} aria-hidden />
      <span className="min-w-0">
        <span className={cn(step.state === "done" || step.state === "skipped" ? "text-muted-foreground" : "text-foreground")}>
          {step.label}
        </span>
        <span className="sr-only"> ({mark.label})</span>
        {step.detail && <span className="text-muted-foreground"> — {step.detail}</span>}
      </span>
    </li>
  );
}

export function StatusToolCard({ output }: { output: unknown }) {
  if (!isStatusSnapshot(output)) return null;
  return <StatusCard snapshot={output} />;
}

export function StatusCard({ snapshot }: { snapshot: StatusSnapshot }) {
  return (
    <div className="my-1 rounded-lg border border-border bg-card px-3 py-2 text-card-foreground">
      <p className="mb-1 font-mono text-[10px] tracking-wide text-muted-foreground uppercase">Status</p>
      <ul>
        {snapshot.steps.map((step) => (
          <li key={step.label}>
            <ul>
              <StepRow step={step} />
              {step.children?.map((child) => (
                <StepRow key={`${step.label}/${child.label}`} step={child} nested />
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {snapshot.note && <p className="mt-1 text-xs text-muted-foreground">{snapshot.note}</p>}
    </div>
  );
}
