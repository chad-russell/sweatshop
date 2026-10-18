/**
 * Sandbox read-model shapes (queries live in @/db/sandbox-view) — split
 * per 0049.
 */

export interface SandboxRef {
  id: string;
  status: string;
  /** Human label for the owner: a chat title or machine run name. */
  ownerLabel: string;
  ownerKind: string;
  ownerId: string;
  /** True when this conversation owns it (vs. joined someone else's). */
  own: boolean;
}

/** Where the conversation's sandboxed calls run (0013: its binding). */
export type SandboxState =
  | { kind: "none" }
  /** No sandbox exists yet; one is created on first use. */
  | { kind: "pending" }
  /** Plain chat with no project and no attach: nothing to run in. */
  | { kind: "unavailable" }
  | { kind: "own"; sandboxId: string; workDir: string }
  | { kind: "attached"; sandboxId: string; workDir: string };

export interface ConversationSandboxView {
  state: SandboxState;
  /** Every sandbox the state references, by id. */
  sandboxes: Record<string, SandboxRef>;
}

export interface SandboxSummary {
  id: string;
  status: string;
  provider: string;
  ref: string;
  ownerKind: string;
  ownerId: string;
  ownerLabel: string;
  /** Where the owner lives in the app (its chat or run page). */
  ownerHref: string;
  projectId: string | null;
  projectName: string | null;
  createdAt: number;
  lastUsedAt: number;
  destroyedAt: number | null;
  /** Distinct chats bound to it (owning or attached). */
  chats: number;
}

export interface SandboxUser {
  conversationId: string;
  title: string | null;
  /** Owner (own dedicated sandbox) vs. joined someone else's. */
  owner: boolean;
  lastAt: number | null;
}

export interface SandboxDetail extends SandboxSummary {
  users: SandboxUser[];
}

export interface SandboxLink {
  id: string;
  status: string;
  /** Short note for the UI: how this thing relates to the sandbox. */
  note: string;
}
