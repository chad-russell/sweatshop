"use client";

import type { UIMessage } from "ai";
import { ChevronsUpDown, Workflow } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { liveBackgroundChildIds } from "@/lib/chat-ui";
import type { ChildStatus } from "@/lib/child-status";
import { useChildStatus } from "@/lib/use-child-status";
import { cn } from "@/lib/utils";

function workLabel(status: ChildStatus): string {
  if (status.kind === "harness") return status.href.split("/")[2] ?? "harness";
  return status.where ?? "thread";
}

function ChildWatcher({ id, onChange }: { id: string; onChange: (id: string, status: ChildStatus | null) => void }) {
  const status = useChildStatus(id);
  useEffect(() => onChange(id, status), [id, status, onChange]);
  return null;
}

/** Compact live-work chip. Hidden when no background work is running. */
export function WorkChip({ messages, className }: { messages: UIMessage[]; className?: string }) {
  const childIds = useMemo(() => liveBackgroundChildIds(messages), [messages]);
  const [statuses, setStatuses] = useState<Record<string, ChildStatus | null>>({});
  const onChange = useCallback((id: string, status: ChildStatus | null) => {
    setStatuses((current) => (current[id] === status ? current : { ...current, [id]: status }));
  }, []);
  const working = childIds.map((id) => statuses[id]).filter((status): status is ChildStatus => Boolean(status?.live));

  return (
    <>
      {childIds.map((id) => <ChildWatcher key={id} id={id} onChange={onChange} />)}
      {working.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label={`${working.length} working`} className={cn("inline-flex h-8 pointer-coarse:h-10 items-center gap-1 rounded-lg border border-border px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground", className)}>
              <Workflow className="size-3.5" aria-hidden />
              <span>{working.length} working</span>
              <ChevronsUpDown className="size-3.5" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72 max-w-[calc(100vw-1rem)]">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Working now</DropdownMenuLabel>
            {working.map((status) => (
              <DropdownMenuItem key={status.id} asChild className="items-start py-1.5">
                <Link href={status.href} className="flex min-w-0 flex-col">
                  <span className="truncate text-sm">{status.phase ? `${status.phase} · ` : ""}{workLabel(status)}</span>
                  <span className="text-xs font-normal text-muted-foreground">{status.status}</span>
                </Link>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}
