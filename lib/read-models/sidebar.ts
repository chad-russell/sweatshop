/**
 * Sidebar read-model shapes (queries live in @/db/organize) — split per 0049.
 */

export interface SidebarItem {
  id: string;
  title: string | null;
  updatedAt: number;
  /** 0040 phase 2: when it was created — children sort oldest-first by
   *  this (lib/sidebar-tree.ts), independent of updatedAt's recency sort. */
  createdAt: number;
  /** "chat" (stage and — 0048 — historical run rows never reach the
   *  sidebar); 0046 also "harness" — synthetic read-model rows for
   *  harness_calls sessions injected by loadSidebar, with no
   *  conversations row. */
  kind: string;
  /** 0046: the harness call's status for harness rows; null for chats. */
  runStatus: string | null;
  /** 0037 phase 3 / 0040 phase 2: the `start_thread` parent, when this is
   *  a child — nests it in the sidebar tree (lib/sidebar-tree.ts). Null
   *  for an ordinary chat. */
  parentConversationId: string | null;
  /** 0040 phase 2: a live turn is running right now (any conversation
   *  kind) — rolls up into a collapsed parent's aggregate indicator. */
  activeRunId: string | null;
  /** 0008: assistant output the user has not viewed yet. */
  unread: boolean;
  /** 0008: a pending approval/question is waiting on the user. */
  needsYou: boolean;
  /** 0046: the harness name ("pi" | "claude" | "cursor" | "codex") when kind is
   *  "harness" — a synthetic row for a harness_calls entry (no
   *  conversations row exists), carried so the row can build its href
   *  (/h/<harness>/<owning conversation>). Null for conversations. */
  harness?: string | null;
  /** 0046: a child thread whose newest assistant row is marked
   *  `metadata.exhausted` (its last turn ran out of steps) — the ⚠ glyph.
   *  Null otherwise and for every non-child row. */
  threadStatus?: "exhausted" | null;
  /** 0055 v7 part B: the phase (display name) a harness row or child
   *  thread was started to do — null when the parent wasn't moded, had
   *  no phases, or for every non-child/non-harness row. */
  phase?: string | null;
}

/** Rolled-up attention counts for a collapsible container. */
export interface AttentionCounts {
  unread: number;
  needsYou: number;
}

export interface FolderNode {
  id: string;
  name: string;
  /** Newest activity in the folder or any descendant; createdAt if empty. */
  activityAt: number;
  folders: FolderNode[];
  items: SidebarItem[];
  /** Conversations at or below this folder. */
  count: number;
  /** Attention at or below this folder (shown while it is collapsed). */
  attention: AttentionCounts;
}

export interface SidebarGroup {
  project: { id: string; name: string } | null;
  folders: FolderNode[];
  /** Conversations not filed in any folder (shown as "Unfiled"). */
  unfiled: SidebarItem[];
  attention: AttentionCounts;
}

/** A conversation outside the main tree (Archive / Trash view) — flat,
 *  no parent/child nesting (0040 phase 2 scopes the tree to the live
 *  library; a breadcrumb already says where an archived/trashed item
 *  came from). */
export interface ShelvedItem
  extends Omit<SidebarItem, "unread" | "needsYou" | "runStatus" | "parentConversationId" | "activeRunId"> {
  projectName: string | null;
  /** Folder breadcrumb, e.g. ["Spikes", "Sandbox"]. */
  path: string[];
  at: number;
}

export interface SidebarData {
  groups: SidebarGroup[];
  archived: ShelvedItem[];
  trashed: ShelvedItem[];
}

/** Which conversations carry a dot (see db/attention.ts loadAttention). */
export interface AttentionFlags {
  unread: ReadonlySet<string>;
  needsYou: ReadonlySet<string>;
}
