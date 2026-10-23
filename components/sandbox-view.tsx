"use client";

import { createContext, useContext, type ReactNode } from "react";

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

/** Tools whose calls run inside the chat's sandbox (the composer's sandbox
 *  picker shows which; there is no per-row chip — it was the same id on
 *  every row). */
export const SANDBOXED_TOOLS = new Set(["bash", "pi", "claude", "cursor", "codex"]);
