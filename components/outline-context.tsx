"use client";

import { MessageResponse } from "@/components/ai-elements/message";
import { ChevronRight, ListTree } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/** 0064: the outline context a worker was given (goal + its step's
 * subtree), collapsed by default. */
export function OutlineContextBlock({ text, className }: { text: string; className?: string }) {
  const label = "Outline context";
  return (
    <Collapsible className={cn("border-t border-border", className)}>
      <CollapsibleTrigger className="group flex w-full items-center gap-1 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
        <ListTree className="size-3 shrink-0" aria-hidden />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <MessageResponse className="px-3 pb-2 text-xs leading-relaxed text-muted-foreground">{text}</MessageResponse>
      </CollapsibleContent>
    </Collapsible>
  );
}
