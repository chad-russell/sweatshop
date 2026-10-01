"use client";

import { Ellipsis } from "lucide-react";
import { DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/** Hover-revealed "⋯" button; always visible on touch (coarse pointers). */
export function RowMenuTrigger({ label }: { label: string }) {
  return (
    <DropdownMenuTrigger asChild>
      <button
        type="button"
        aria-label={label}
        className="absolute top-1/2 right-1 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-sidebar-foreground/60 opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
      >
        <Ellipsis className="size-4" />
      </button>
    </DropdownMenuTrigger>
  );
}
