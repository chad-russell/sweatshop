"use client";

import { ClipboardList } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PlanApprove, PlanDocument } from "@/components/plan-card";
import type { NeedsYouThread, PendingRequest } from "@/lib/read-models/attention";
import { Where } from "./where";

/**
 * 0041: a plan in review. Approve here (optional note) or open the
 * thread to discuss it — a review never blocks the agent, so there is
 * no Deny: disagreeing is just a reply in the thread.
 */
export function PlanReviewCard({
  thread,
  request,
  onAnswered,
}: {
  thread: NeedsYouThread;
  request: PendingRequest;
  onAnswered: (requestId: string) => void;
}) {
  const plan = request.plan;
  return (
    <article className="flex flex-col gap-3 rounded-lg border border-warning/50 bg-card p-4 text-card-foreground">
      <header className="flex flex-col gap-1">
        <Link href={`/c/${thread.id}`} className="truncate text-sm font-medium hover:underline">
          {thread.title ?? thread.id}
        </Link>
        <Where projectName={thread.projectName} path={thread.path} at={request.at} />
      </header>
      <p className="flex items-center gap-2 text-sm">
        <ClipboardList className="size-4 shrink-0 text-warning" aria-hidden />
        <span className="font-medium">{plan ? `Plan v${plan.version}` : request.prompt}</span>
        {plan && plan.checklist.total > 0 && (
          <span className="font-mono text-xs text-muted-foreground">{plan.checklist.total} steps</span>
        )}
        {plan?.note && <span className="min-w-0 truncate text-muted-foreground">— {plan.note}</span>}
      </p>
      {plan && (
        <details className="rounded-md border bg-background px-3 py-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">Read the plan</summary>
          <PlanDocument markdown={plan.markdown} className="mt-2" />
        </details>
      )}
      <PlanApprove toolCallId={request.requestId} version={plan?.version ?? 0} onApproved={() => onAnswered(request.requestId)} />
      <div className="flex justify-end">
        <Button asChild size="sm" variant="ghost">
          <Link href={`/c/${thread.id}`}>Discuss in thread</Link>
        </Button>
      </div>
    </article>
  );
}
