"use client";

import { Box } from "lucide-react";
import Link from "next/link";
import { createContext, useContext, type ReactNode } from "react";
import { shortSandboxId } from "@/lib/sandbox-id";
import { cn } from "@/lib/utils";

/**
 * 0011 phase 2: the chat's sandbox read-model (db/sandbox-view.ts via
 * GET /api/conversations/[id]/sandbox), shared with the tool cards so each
 * sandboxed call can say which sandbox it ran in.
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
  calls: Record<string, { sandboxId: string; via: "dedicated" | "attached"; changed: boolean }>;
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
 * Which sandbox one tool call ran in; links to its /sandboxes page.
 * Renders nothing for calls with no record (made before 0011, or not yet
 * recorded).
 */
export function SandboxChip({
  toolCallId,
  className,
}: {
  toolCallId: string;
  className?: string;
}) {
  const view = useSandboxView();
  const call = view?.calls[toolCallId];
  if (!view || !call) return null;
  const sandbox = view.sandboxes[call.sandboxId];
  const gone = sandbox?.status === "destroyed";
  const where =
    call.via === "attached"
      ? `attached · ${sandbox?.ownerLabel ?? "another sandbox"}`
      : "own sandbox";

  return (
    <Link
      href={`/sandboxes/${call.sandboxId}`}
      title={[
        `Ran in sandbox ${call.sandboxId}`,
        where,
        gone ? "(since destroyed)" : null,
        call.changed ? "Different sandbox than the previous call" : null,
      ]
        .filter(Boolean)
        .join(" — ")}
      className={cn(
        "inline-flex max-w-full shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] leading-4",
        call.changed
          ? "border-warning/50 bg-warning/10 text-warning"
          : "border-border bg-muted/50 text-muted-foreground",
        "transition-colors hover:border-ring hover:text-foreground",
        gone && "opacity-60",
        className,
      )}
    >
      <Box className="size-3 shrink-0" aria-hidden />
      <span className={cn("truncate", gone && "line-through")}>
        {shortSandboxId(call.sandboxId)}
      </span>
      {call.via === "attached" && <span aria-hidden>↗</span>}
      {call.changed && <span className="font-sans">switched</span>}
    </Link>
  );
}
