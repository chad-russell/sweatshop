"use client";

import { ShieldQuestion } from "lucide-react";
import Link from "next/link";
import { cn } from "cn";
import { ApprovalEvidenceView } from "@/components/approval-evidence";
import { PromptChangeDetails } from "@/components/chat-cards/approvals";
import { Button } from "@/components/ui/button";
import type { NeedsYouThread, PendingRequest, RequestOption } from "@/lib/read-models/attention";

/** 0043: an exec ask — host line + the command as it will run, not JSON. */
function ExecAsk({ exec }: { exec: NonNullable<PendingRequest["exec"]> }) {
  return (
    <div className="rounded-md border border-terminal-border bg-terminal px-3 py-2 font-mono text-xs">
      {exec.description && (
        <p className="mb-1 font-sans text-[13px] font-medium text-terminal-foreground">{exec.description}</p>
      )}
      <div className="flex flex-wrap items-center gap-x-2 text-terminal-muted">
        <span className="text-terminal-foreground">{exec.user}@{exec.host}</span>
        <span aria-hidden>·</span>
        <span>{exec.address}</span>
        <span aria-hidden>·</span>
        <span>{exec.timeoutSec}s timeout</span>
      </div>
      <pre className="mt-1.5 whitespace-pre-wrap text-terminal-foreground">$ {exec.command}</pre>
    </div>
  );
}
import { Where } from "./where";
import { useRespond } from "./use-respond";

const INPUT_MAX = 600;

function formatInput(input: Record<string, unknown> | null): string | null {
  if (!input) return null;
  const text = JSON.stringify(input, null, 2);
  return text.length > INPUT_MAX ? `${text.slice(0, INPUT_MAX)}…` : text;
}

/** Fallback options when the request carries none. */
const DEFAULT_APPROVAL: RequestOption[] = [
  { id: "approve", label: "Approve", style: "primary" },
  { id: "cancel", label: "Deny", style: "danger" },
];

/**
 * A pending tool approval: what the agent wants to run, with Approve /
 * Deny as buttons. Answering goes to /api/x/input, which resolves the
 * row before responding — a refused answer never silently disappears.
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
  const { respond, busy, error } = useRespond();
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
          {request.exec && <ExecAsk exec={request.exec} />}
          {request.promptChange && <PromptChangeDetails card={request.promptChange} />}
          {!request.exec && !request.promptChange && input && (
            <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
              {input}
            </pre>
          )}
          {request.evidence && <ApprovalEvidenceView evidence={request.evidence} />}
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
