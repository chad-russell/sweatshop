"use client";

import { ChevronDownIcon, ChevronRightIcon, ChevronsUpDownIcon, CircleCheckIcon, CircleXIcon, Loader2Icon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Pill } from "@/components/ai-elements/agent-cards";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { callLabel, callState, toolName, type CallState, type GroupEntry, type ToolGroup } from "@/lib/tool-groups";
import { cn } from "@/lib/utils";

const STATE_ICON: Record<CallState, { Icon: typeof CircleCheckIcon; className: string }> = {
  ok: { Icon: CircleCheckIcon, className: "text-success" },
  failed: { Icon: CircleXIcon, className: "text-destructive" },
  running: { Icon: Loader2Icon, className: "animate-spin text-info" },
};

/** One call inside a group: a single line; click it for the full card. */
function Row({ entry, render }: { entry: GroupEntry; render: (entry: GroupEntry) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const state = callState(entry.part);
  const { Icon, className } = STATE_ICON[state];
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-1 text-left transition-colors hover:bg-accent/50"
      >
        <Icon className={cn("size-3.5 shrink-0", className)} aria-hidden />
        <span className="w-24 shrink-0 truncate text-[11px] text-muted-foreground">{toolName(entry.part).replace(/_/g, " ")}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={callLabel(entry.part)}>
          {callLabel(entry.part)}
        </span>
        {entry.count > 1 && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">×{entry.count}</span>}
        <ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden />
      </button>
      {open && <div className="px-2 pb-1.5">{render(entry)}</div>}
    </li>
  );
}

/**
 * A run of quiet, read-only tool calls folded into one line: what the agent
 * did, how it went, and — while it is still going — what it is doing now.
 * Expand for one line per call (identical polls already merged ×N); expand
 * a line for the full card. Never hides a failure: the header goes red and
 * names the first failing call.
 */
export function ToolGroupView({ group, render }: { group: ToolGroup; render: (entry: GroupEntry) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const live = group.running > 0;
  const failed = group.failed > 0;
  const tone = failed ? "fail" : live ? "running" : "ok";
  const pill = failed ? `${group.failed} failed` : live ? "running" : "done";
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "group not-prose my-1 w-full overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm",
        failed ? "border-destructive/40" : "border-border",
      )}
    >
      <CollapsibleTrigger
        aria-label={open ? "Hide calls" : "Show calls"}
        className="flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left"
      >
        <ChevronsUpDownIcon className={cn("size-4 shrink-0", failed ? "text-destructive" : "text-muted-foreground")} aria-hidden />
        <span className="shrink-0 text-xs capitalize text-muted-foreground">{group.summary.split(" · ")[0]}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {group.summary.includes(" · ") ? `· ${group.summary.split(" · ").slice(1).join(" · ")}` : ""}
          {(live || failed) && (
            <span className="ml-2 font-mono text-[11.5px] text-foreground" title={callLabel(group.focus)}>
              {callLabel(group.focus)}
            </span>
          )}
        </span>
        <Pill tone={tone} label={pill} />
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="max-h-96 overflow-y-auto border-t border-border bg-muted/30 py-1">
          {group.entries.map((entry) => (
            <Row key={entry.key} entry={entry} render={render} />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
