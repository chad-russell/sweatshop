"use client";

import { ChevronDownIcon, ChevronsUpDownIcon, CircleCheckIcon, CircleXIcon, Loader2Icon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Pill } from "@/components/ai-elements/agent-cards";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import { callLabel, callState, groupStatus, toolName, type CallState, type GroupEntry, type ToolGroup } from "@/lib/tool-views/groups";
import { cn } from "@/lib/utils";

const STATE_ICON: Record<CallState, { Icon: typeof CircleCheckIcon; className: string }> = {
  ok: { Icon: CircleCheckIcon, className: "text-success" },
  failed: { Icon: CircleXIcon, className: "text-destructive" },
  running: { Icon: Loader2Icon, className: "animate-spin text-info motion-reduce:animate-none" },
};

/** One call inside a group: a single line; click it for the full card. */
function Row({ entry, render }: { entry: GroupEntry; render: (entry: GroupEntry) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const state = callState(entry.part);
  const { Icon, className } = STATE_ICON[state];
  const label = callLabel(entry.part);
  const name = toolName(entry.part).replace(/_/g, " ");
  return (
    <li>
      <TraceCollapsible open={open} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger className="w-full gap-2 px-1 py-1 hover:bg-accent/50">
          <TraceLine status={state === "failed" ? "error" : state === "running" ? "running" : undefined} className="flex-1 text-xs">
            <TraceIcon className={className}><Icon /></TraceIcon>
            <span className="sr-only">{state === "ok" ? "Completed" : state === "failed" ? "Failed" : "Running"}: </span>
            <TraceTitle className={cn("text-foreground", state === "failed" && "text-destructive")} title={label}>{label}</TraceTitle>
            {label.toLowerCase() !== name && <TraceDescription className="hidden truncate font-mono text-[10px] sm:inline">{name}</TraceDescription>}
            {entry.count > 1 && <TraceDescription className="font-mono text-[11px]">×{entry.count}<span className="sr-only"> calls</span></TraceDescription>}
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="[&>div]:my-0 [&>div]:rounded-none [&>div]:border-0 [&>div]:shadow-none [&>div>div:first-child]:flex-wrap [&>div>div:first-child>div]:min-w-24">
          {open && render(entry)}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </li>
  );
}

/**
 * A run of quiet, read-only tool calls folded into one line: what the agent
 * did, how it went, and — while it is still going — what it is doing now.
 * Expand for one line per call (identical polls already merged ×N); expand
 * a line for the full card. Failures stay red on their own steps and are
 * counted in the header, without declaring the whole task failed.
 */
export function ToolGroupView({ group, render }: { group: ToolGroup; render: (entry: GroupEntry) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const live = group.running > 0;
  const status = groupStatus(group);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="not-prose my-1 w-full min-w-0 overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-sm"
    >
      <CollapsibleTrigger
        aria-label={`${open ? "Hide" : "Show"} calls: ${group.summary}; ${status.label}`}
        className="group/tool-group-trigger grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1.5 px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:flex"
      >
        <ChevronsUpDownIcon className={cn("size-4 shrink-0", live ? "text-info" : "text-muted-foreground")} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={group.summary}>
          {group.summary.charAt(0).toUpperCase() + group.summary.slice(1)}
          {live && (
            <span className="ml-2 font-mono text-[11.5px] text-foreground" title={callLabel(group.focus)}>
              {callLabel(group.focus)}
            </span>
          )}
        </span>
        <span className="col-start-2 row-start-2 justify-self-start sm:contents"><Pill tone={status.tone} label={status.label} /></span>
        <ChevronDownIcon className="col-start-3 row-start-1 size-4 shrink-0 text-muted-foreground transition-transform group-aria-expanded/tool-group-trigger:rotate-180 motion-reduce:transition-none" aria-hidden />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Trace className="max-h-96 overflow-y-auto border-t border-border bg-muted/30 px-3 py-2">
          <ol aria-label="Tool calls" className="space-y-0.5">
            {group.entries.map((entry) => (
              <Row key={entry.key} entry={entry} render={render} />
            ))}
          </ol>
        </Trace>
      </CollapsibleContent>
    </Collapsible>
  );
}
