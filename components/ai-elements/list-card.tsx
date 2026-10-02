"use client";

import {
  ChevronDownIcon,
  FileIcon,
  FolderIcon,
  FolderSearchIcon,
  FolderTreeIcon,
  SearchIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { parseListTool, type ListToolName } from "@/lib/list-tool-view";
import { cn } from "@/lib/utils";

const OPEN_ENTRIES = 12;
const MAX_ENTRIES = 300;

const ICON = { ls: FolderTreeIcon, grep: SearchIcon, glob: FolderSearchIcon, find: FolderSearchIcon } as const;
const LABEL = { ls: "Listed", grep: "Searched", glob: "Matched", find: "Found" } as const;

/** A harness listing/search call (ls / grep / glob / find): the thing asked,
 *  a count, and the entries — folders and files, or grep hits with line numbers. */
export function ListCard({
  tool,
  state,
  input,
  output,
  errorText,
  className,
}: {
  tool: ListToolName;
  state: "running" | "completed" | "error";
  input: unknown;
  output?: unknown;
  errorText?: string;
  className?: string;
}) {
  const view = useMemo(() => parseListTool(tool, input, output), [tool, input, output]);
  const failed = state === "error";
  const count = view.entries.length;
  const [open, setOpen] = useState(failed || (count > 0 && count <= OPEN_ENTRIES));
  const Icon = ICON[tool];
  const shown = view.entries.slice(0, MAX_ENTRIES);
  const hidden = count - shown.length;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "group not-prose w-full overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm",
        failed ? "border-destructive/40" : "border-border",
        className,
      )}
    >
      <div className="flex items-center gap-2.5 px-3 py-2">
        <Icon className={cn("size-4 shrink-0", failed ? "text-destructive" : "text-muted-foreground")} aria-hidden />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-xs text-muted-foreground">{LABEL[tool]}</span>
          <span className="min-w-0 truncate font-mono text-[12.5px] font-medium" title={view.arg}>
            {view.arg || "…"}
          </span>
        </div>
        {state !== "running" && !failed && (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            {count} {count === 1 ? view.noun.one : view.noun.many}
          </span>
        )}
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] leading-none",
            failed
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : state === "running"
                ? "border-info/30 bg-info/10 text-info"
                : "border-success/30 bg-success/10 text-success",
          )}
        >
          <span aria-hidden className={cn("size-1.5 rounded-full bg-current", state === "running" && "animate-pulse")} />
          {failed ? "failed" : state === "running" ? "running" : "done"}
        </span>
        {count > 0 && (
          <CollapsibleTrigger
            aria-label={open ? "Hide entries" : "Show entries"}
            className="-mr-1 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
        )}
      </div>

      {count > 0 && (
        <CollapsibleContent>
          <ul className="max-h-72 overflow-auto border-t border-border bg-muted/30 py-1.5 font-mono text-[12px] leading-relaxed">
            {shown.map((entry, i) => (
              <li key={i} className="flex items-baseline gap-2 px-3">
                {entry.kind === "dir" ? (
                  <FolderIcon className="size-3.5 shrink-0 translate-y-0.5 text-info" aria-hidden />
                ) : (
                  <FileIcon className="size-3.5 shrink-0 translate-y-0.5 text-muted-foreground" aria-hidden />
                )}
                <span className={cn("shrink-0", entry.kind === "dir" && "font-medium")}>{entry.path}</span>
                {entry.kind === "match" && (
                  <>
                    <span className="shrink-0 text-muted-foreground">:{entry.line}</span>
                    <span className="min-w-0 truncate text-muted-foreground">{entry.text}</span>
                  </>
                )}
              </li>
            ))}
            {hidden > 0 && <li className="px-3 pt-1 italic text-muted-foreground">… {hidden} more</li>}
          </ul>
        </CollapsibleContent>
      )}

      {view.notes.length > 0 && (
        <p className="border-t border-border bg-muted/30 px-3 py-1.5 font-mono text-[11px] italic text-muted-foreground">
          {view.notes.join(" · ")}
        </p>
      )}
      {!failed && state === "completed" && count === 0 && (
        <p className="border-t border-border bg-muted/30 px-3 py-1.5 font-mono text-[11px] italic text-muted-foreground">
          nothing found
        </p>
      )}
      {failed && (
        <p className="border-t border-destructive/30 bg-destructive/10 px-3 py-2 font-mono text-[11px] text-destructive">
          {errorText ?? "tool failed"}
        </p>
      )}
    </Collapsible>
  );
}
