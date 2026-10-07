"use client";

import { Box } from "lucide-react";
import Link from "next/link";
import { createContext, useContext, type ReactNode } from "react";
import { shortSandboxId } from "@/lib/sandbox-id";
import { cn } from "@/lib/utils";

/**
 * The chat's sandbox read-model (db/sandbox-view.ts via
 * GET /api/conversations/[id]/sandbox), shared with the tool cards.
 * 0031: per-call attribution is gone — the conversation's binding is
 * the record, so every sandboxed tool card shows the same chip.
 */

export interface SandboxRefView {
  id: string;
  status: string;
  ownerLabel: string;
  ownerKind: string;
  ownerId: string;
  own: boolean;
}

export type SandboxStateView =
  | { kind: "none" }
  | { kind: "pending" }
  | { kind: "unavailable" }
  | { kind: "own"; sandboxId: string; workDir: string }
  | { kind: "attached"; sandboxId: string; workDir: string };

export interface ConversationSandboxViewData {
  state: SandboxStateView;
  sandboxes: Record<string, SandboxRefView>;
}

const SandboxViewContext = createContext<ConversationSandboxViewData | null>(null);

export function SandboxViewProvider({
  value,
  children,
}: {
  value: ConversationSandboxViewData | null;
  children: ReactNode;
}) {
  return <SandboxViewContext.Provider value={value}>{children}</SandboxViewContext.Provider>;
}

export function useSandboxView(): ConversationSandboxViewData | null {
  return useContext(SandboxViewContext);
}

/** Tools whose calls run inside a sandbox (and so get a chip). */
export const SANDBOXED_TOOLS = new Set(["bash", "pi", "claude"]);

/**
 * The sandbox this conversation's sandboxed calls run in (its binding),
 * linking to the sandbox page. Renders nothing without a bound sandbox.
 */
export function SandboxChip({ className }: { className?: string }) {
  const view = useSandboxView();
  const state = view?.state;
  if (!view || !state || (state.kind !== "own" && state.kind !== "attached")) return null;
  const sandbox = view.sandboxes[state.sandboxId];
  const gone = sandbox?.status === "destroyed";
  const where =
    state.kind === "attached"
      ? `attached · ${sandbox?.ownerLabel ?? "another sandbox"}`
      : "own sandbox";

  return (
    <Link
      href={`/sandboxes/${state.sandboxId}`}
      title={[`Runs in sandbox ${state.sandboxId}`, where, gone ? "(since destroyed)" : null]
        .filter(Boolean)
        .join(" — ")}
      className={cn(
        "inline-flex max-w-full shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] leading-4",
        "border-border bg-muted/50 text-muted-foreground",
        "transition-colors hover:border-ring hover:text-foreground",
        gone && "opacity-60",
        className,
      )}
    >
      <Box className="size-3 shrink-0" aria-hidden />
      <span className={cn("truncate", gone && "line-through")}>
        {shortSandboxId(state.sandboxId)}
      </span>
      {state.kind === "attached" && <span aria-hidden>↗</span>}
    </Link>
  );
}
