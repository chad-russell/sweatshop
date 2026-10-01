"use client";

import { ShieldQuestion } from "lucide-react";
import Link from "next/link";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import type { NeedsYouThread, PendingRequest, RequestOption } from "@/db/attention";
import { Where } from "./where";
import { useRespond } from "./use-respond";

const INPUT_MAX = 600;

function formatInput(input: Record<string, unknown> | null): string | null {
  if (!input) return null;
  const text = JSON.stringify(input, null, 2);
  return text.length > INPUT_MAX ? `${text.slice(0, INPUT_MAX)}…` : text;
}

/** Fallback options when eve sends none (it normally does). */
const DEFAULT_APPROVAL: RequestOption[] = [
  { id: "approve", label: "Approve", style: "primary" },
  { id: "cancel", label: "Deny", style: "danger" },
];

/**
 * A pending tool approval (or session-limit confirmation): what the agent
 * wants to run, with the options eve offered as buttons. Answering goes
 * straight to the session; the card stays until eve records the
 * resolution, so a refused answer never silently disappears.
 */
export function ApprovalCard({
  thread,
  request,
  onAnswered,
}: {
  thread: NeedsYouThread;
  request: PendingRequest;
  onAnswered: (requestId: string) => void;
}) {
  const { respond, busy, error } = useRespond(thread.id);
  const options = request.options.length > 0 ? request.options : DEFAULT_APPROVAL;
  const input = formatInput(request.toolInput);

  return (
    <article className="flex flex-col gap-3 rounded-lg border border-warning/50 bg-card p-4 text-card-foreground">
      <header className="flex flex-col gap-1">
        <Link
          href={`/c/${thread.id}`}
          className="truncate text-sm font-medium hover:underline"
        >
          {thread.title ?? thread.id}
        </Link>
        <Where projectName={thread.projectName} path={thread.path} at={request.at} />
      </header>
      <div className="flex items-start gap-2">
        <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm">
            {request.toolName && (
              <code className="mr-1.5 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                {request.toolName}
              </code>
            )}
            {request.prompt}
          </p>
          {input && (
            <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
              {input}
            </pre>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {options.map((option) => (
          <Button
            key={option.id}
            size="sm"
            variant={
              option.style === "danger"
                ? "destructive"
                : option.style === "primary"
                  ? "default"
                  : "outline"
            }
            disabled={busy}
            title={option.description}
            onClick={async () => {
              const ok = await respond([{ requestId: request.requestId, optionId: option.id }]);
              if (ok) onAnswered(request.requestId);
            }}
          >
            {option.label}
          </Button>
        ))}
        <Button asChild size="sm" variant="ghost" className="ml-auto">
          <Link href={`/c/${thread.id}`}>Open thread</Link>
        </Button>
      </div>
      {error && (
        <p role="alert" className={cn("text-xs text-destructive")}>
          {error}
        </p>
      )}
    </article>
  );
}
