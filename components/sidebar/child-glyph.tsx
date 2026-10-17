import { Bot, CircleAlert } from "lucide-react";
import { HarnessMark } from "@/components/harness-logo";
import { cn } from "cn";
import { childGlyphKind } from "@/lib/child-glyph";
import { RunGlyph } from "./run-glyph";
import type { SidebarItem } from "./types";

/** 0046: a child row's status glyph (lib/child-glyph.ts decides which). */
export function ChildGlyph({ item }: { item: SidebarItem }) {
  const kind = childGlyphKind(item);
  const base = "size-3.5 shrink-0";
  switch (kind) {
    case "none":
      return null;
    case "harness-done":
      return (
        <span aria-label="Completed" className="inline-flex">
          <HarnessMark kind={item.harness ?? ""} tint={false} className={cn(base, "text-sidebar-foreground/60")} />
        </span>
      );
    case "agent-done":
      return <Bot aria-label="Thread finished" className={cn(base, "text-sidebar-foreground/60")} />;
    case "needs-attention":
      return <CircleAlert aria-label={item.kind === "chat" ? "Ran out of steps" : "Needs attention"} className={cn(base, "text-warning")} />;
    default:
      return <RunGlyph status={kind} />;
  }
}
