"use client";

import { ClipboardList } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { isLegacyPlanSnapshot } from "@/lib/legacy-plan";

/** Historical present_plan output. Plans can no longer be changed or approved. */
export function LegacyPlanCard({ output, failed }: { output: unknown; failed?: boolean }) {
  if (failed) return <p className="my-2 text-xs text-destructive">Plan (legacy): present_plan failed.</p>;
  if (!isLegacyPlanSnapshot(output)) return null;
  return (
    <section className="my-2 rounded-lg border border-border bg-card p-3 text-card-foreground">
      <header className="mb-2 flex items-center gap-2 text-sm font-medium">
        <ClipboardList className="size-4 text-muted-foreground" aria-hidden />
        Plan v{output.version} <span className="text-xs font-normal text-muted-foreground">legacy · read only</span>
      </header>
      <MessageResponse>{output.markdown}</MessageResponse>
    </section>
  );
}
