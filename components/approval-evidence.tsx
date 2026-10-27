"use client";

import { CheckCircle2, CircleSlash, XCircle } from "lucide-react";
import type { ApprovalEvidence } from "@/lib/agent/tools/evidence";
import { DiffBreakdownChip } from "@/components/diff-breakdown";
import { cn } from "@/lib/utils";

/**
 * 0037 phase 1: the runtime-built evidence on a gated tool's approval
 * card — the test check the runtime ran itself and the thread's
 * screenshots. Shared by the inbox card and the transcript's pending
 * create_pr card, so both show the same facts.
 */
export function ApprovalEvidenceView({ evidence }: { evidence: ApprovalEvidence }) {
  const check = evidence.check;
  const passed = check?.status === "passed";
  return (
    <div className="space-y-2">
      {evidence.breakdown && <DiffBreakdownChip breakdown={evidence.breakdown} />}
      <div
        className={cn(
          "rounded-md border p-2 text-xs",
          !check ? "border-border" : passed ? "border-success/40" : "border-destructive/40",
        )}
      >
        <p className="flex items-center gap-1.5 font-medium">
          {!check ? (
            <CircleSlash className="size-3.5 text-muted-foreground" aria-hidden />
          ) : passed ? (
            <CheckCircle2 className="size-3.5 text-success" aria-hidden />
          ) : (
            <XCircle className="size-3.5 text-destructive" aria-hidden />
          )}
          {!check
            ? (evidence.checkNote ?? "No test command set on the project")
            : `Tests ${check.status} · ${Math.round(check.durationMs / 1000)}s`}
        </p>
        {check && (
          <>
            <p className="mt-1 truncate font-mono text-muted-foreground" title={check.command}>
              {check.command}
            </p>
            {!passed && check.tail && (
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-muted-foreground">
                {check.tail}
              </pre>
            )}
          </>
        )}
      </div>
      {evidence.screenshots.length > 0 ? (
        <div className="grid grid-cols-3 gap-1">
          {evidence.screenshots.map((shot) => (
            <a
              key={shot.url}
              href={shot.url}
              target="_blank"
              rel="noreferrer"
              title={shot.label}
              className="block overflow-hidden rounded-md border border-border"
            >
              {/* biome-ignore lint/performance/noImgElement: immutable attachment files served by our API */}
              <img
                src={shot.url}
                alt={shot.label ?? "attached screenshot"}
                className="h-28 w-full object-cover object-top hover:opacity-80"
              />
            </a>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No screenshots attached in this thread.</p>
      )}
    </div>
  );
}
