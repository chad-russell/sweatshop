"use client";

import { ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/** 0059: the phase handoff a worker was given, collapsed by default. */
export function PhaseContextBlock({ phase, text, className }: { phase: string; text: string; className?: string }) {
  return (
    <Collapsible className={cn("border-t border-border", className)}>
      <CollapsibleTrigger className="group flex w-full items-center gap-1 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
        Phase context: {phase}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="px-3 pb-2 whitespace-pre-wrap font-sans text-xs leading-relaxed text-muted-foreground">{text}</pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
