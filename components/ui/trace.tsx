"use client";

// shadcn/ui Trace (Radix), adapted to our Collapsible and theme tokens.
// https://ui.shadcn.com/docs/components/radix/trace
import type { ComponentProps } from "react";
import { ChevronRightIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

function Trace({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="trace" className={cn("flex w-full min-w-0 flex-col gap-2", className)} {...props} />;
}

function TraceLine({
  className,
  status,
  ...props
}: ComponentProps<"span"> & { status?: "running" | "error" | "pending" }) {
  return (
    <span
      data-slot="trace-line"
      data-status={status}
      className={cn(
        "flex w-fit min-w-0 max-w-full items-center gap-2 text-sm text-muted-foreground transition-colors data-[status=error]:text-destructive data-[status=pending]:opacity-60",
        className,
      )}
      {...props}
    />
  );
}

function TraceIcon({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-icon"
      aria-hidden="true"
      className={cn("flex size-4 shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:size-4", className)}
      {...props}
    />
  );
}

function TraceTitle({ className, ...props }: ComponentProps<"span">) {
  return <span data-slot="trace-title" className={cn("min-w-0 truncate", className)} {...props} />;
}

function TraceDescription({ className, ...props }: ComponentProps<"span">) {
  return <span data-slot="trace-description" className={cn("shrink-0 text-muted-foreground tabular-nums", className)} {...props} />;
}

function TraceCollapsible({ className, ...props }: Omit<ComponentProps<typeof Collapsible>, "asChild">) {
  return <Collapsible data-slot="trace-collapsible" className={cn("flex w-full min-w-0 flex-col", className)} {...props} />;
}

function TraceCollapsibleTrigger({
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof CollapsibleTrigger>, "asChild">) {
  return (
    <CollapsibleTrigger
      data-slot="trace-collapsible-trigger"
      className={cn(
        "group/trace-trigger flex w-fit min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-md text-left text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring has-[[data-status=error]]:text-destructive",
        className,
      )}
      {...props}
    >
      {children}
      <TraceIcon className="transition-transform group-aria-expanded/trace-trigger:rotate-90 motion-reduce:transition-none">
        <ChevronRightIcon />
      </TraceIcon>
    </CollapsibleTrigger>
  );
}

function TraceCollapsibleContent({
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof CollapsibleContent>, "asChild">) {
  return (
    <CollapsibleContent data-slot="trace-collapsible-content" className="min-w-0 overflow-hidden" {...props}>
      <div
        data-slot="trace-collapsible-content-inner"
        className={cn("mt-2 mb-1 ml-[calc(--spacing(2)-1px)] min-w-0 border-l border-border pr-1 pl-4 leading-relaxed wrap-break-word text-muted-foreground", className)}
      >
        {children}
      </div>
    </CollapsibleContent>
  );
}

export {
  Trace,
  TraceLine,
  TraceIcon,
  TraceTitle,
  TraceDescription,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
};
