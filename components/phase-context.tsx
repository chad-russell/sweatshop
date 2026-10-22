"use client";

import { ChevronRight, ListTree } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/** 0059: the phase handoff a worker was given, collapsed by default. */
export function PhaseContextBlock({ phase, text, className }: { phase: string; text: string; className?: string }) {
  return (
    <ContextBlock label={`Phase context: ${phase}`} text={text} className={className} />
  );
}

/** 0064: the outline context a worker was given (goal + its step's
 * subtree), same collapsed shape as the phase block. */
export function OutlineContextBlock({ text, className }: { text: string; className?: string }) {
  return <ContextBlock label="Outline context" text={text} className={className} />;
}

function ContextBlock({ label, text, className }: { label: string; text: string; className?: string }) {
  return (
    <Collapsible className={cn("border-t border-border", className)}>
      <CollapsibleTrigger className="group flex w-full items-center gap-1 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
        <ListTree className="size-3 shrink-0" aria-hidden />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="px-3 pb-2 whitespace-pre-wrap font-sans text-xs leading-relaxed text-muted-foreground">{text}</pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
