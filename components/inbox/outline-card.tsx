"use client";

import { ListTree } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { OutlineApprove, OutlineDocument } from "@/components/outline-card";
import type { NeedsYouThread, PendingRequest } from "@/lib/read-models/attention";
import { Where } from "./where";

/**
 * 0064: an outline in review. Approve here (optional note) or open the
 * thread to discuss it — a review never blocks the agent, so there is
 * no Deny: disagreeing is just a reply in the thread.
 */
export function OutlineReviewCard({
  thread,
  request,
  onAnswered,
}: {
  thread: NeedsYouThread;
  request: PendingRequest;
  onAnswered: (requestId: string) => void;
}) {
  const outline = request.outline;
  return (
    <article className="flex flex-col gap-3 rounded-lg border border-warning/50 bg-card p-4 text-card-foreground">
      <header className="flex flex-col gap-1">
        <Link href={`/c/${thread.id}`} className="truncate text-sm font-medium hover:underline">
          {thread.label}
        </Link>
        <Where projectName={thread.projectName} path={thread.path} at={request.at} />
      </header>
      <p className="flex items-center gap-2 text-sm">
        <ListTree className="size-4 shrink-0 text-warning" aria-hidden />
        <span className="font-medium">{outline ? `Outline v${outline.version}` : request.prompt}</span>
        {outline && outline.outline.steps.length > 0 && (
          <span className="font-mono text-xs text-muted-foreground">{outline.outline.steps.length} steps</span>
        )}
        {outline?.note && <span className="min-w-0 truncate text-muted-foreground">— {outline.note}</span>}
      </p>
      {outline && (
        <details className="rounded-md border bg-background px-3 py-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">Read the outline</summary>
          <OutlineDocument outline={outline.outline} className="mt-2" />
        </details>
      )}
      <OutlineApprove toolCallId={request.requestId} version={outline?.version ?? 0} onApproved={() => onAnswered(request.requestId)} />
      <div className="flex justify-end">
        <Button asChild size="sm" variant="ghost">
          <Link href={`/c/${thread.id}`}>Discuss in thread</Link>
        </Button>
      </div>
    </article>
  );
}
