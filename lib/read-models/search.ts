/**
 * Search read-model shapes (queries live in @/db/search) — split per 0049.
 */

export interface SearchHit {
  conversationId: string;
  /** 0012: "chat" | "run" — where the hit opens. */
  kind: string;
  title: string | null;
  snippet: string;
  /** Matching message rows (body hits); 0 for a title/summary-only match. */
  hits: number;
  /** Where the best match was found. */
  matchedIn: "title" | "body";
  projectId: string | null;
  projectName: string | null;
  /** Folder breadcrumb within the group, e.g. ["Spikes", "Sandbox"]. */
  path: string[];
  archived: boolean;
  updatedAt: number;
  /** 0040 phase 2: the `start_thread` parent's title, when this hit is a
   *  child — search stays a flat list, but this is cheap (the full
   *  conversation map is already in hand) and worth the hint. Null for
   *  an ordinary chat, or a child whose parent has no title yet. */
  parentTitle: string | null;
}

export interface SearchOptions {
  limit?: number;
  /** Restrict to one project id; "none" restricts to unbound (Chats). */
  project?: string;
  /** Restrict to a folder and everything below it. */
  folder?: string;
  /** Include archived conversations (default true). Trashed never match. */
  includeArchived?: boolean;
}
