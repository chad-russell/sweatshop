import { stripToolPlaceholders } from "../../lib/conversation-label";
import { eq, sql } from "drizzle-orm";
import type { ChatRoute } from "../../lib/providers/route";
import type { Db } from "../index";
import { parseStoredChatRoute } from "../providers";
import { conversations, messages } from "../schema";
import type { MessageRowMetadata } from "./messages";

/**
 * 0010 spike store: conversation CRUD, settings columns, and the
 * start_thread child/wake bookkeeping that reads `conversations` and
 * its own assistant history.
 */

/** Create the conversation row if absent (new-runtime ids: `c_…`).
 *  0012: machine agent-stage visits pass kind "stage" (hidden rows). */
export function ensureConversation(
  db: Db,
  id: string,
  projectId: string | null = null,
  kind: "chat" | "stage" = "chat",
): void {
  const now = Date.now();
  db.insert(conversations)
    .values({ id, projectId, kind, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run();
}

/** The conversation row (new-runtime store reads; null when absent). */
export function getConversation(
  db: Db,
  id: string,
): {
  id: string;
  projectId: string | null;
  /** 0021: the conversation's own route (null = project / global default). */
  route: ChatRoute | null;
  /** 0007: set while the conversation sits in Trash (0022: no wakes). */
  trashedAt: number | null;
  /** 0037 phase 3: the start_thread parent, when this is a child (0040
   *  phase 3: a child gets the thread step budget). */
  parentConversationId: string | null;
} | null {
  const row = db
    .select({
      id: conversations.id,
      projectId: conversations.projectId,
      route: conversations.route,
      trashedAt: conversations.trashedAt,
      parentConversationId: conversations.parentConversationId,
    })
    .from(conversations)
    .where(eq(conversations.id, id))
    .get();
  return row ? { ...row, route: parseStoredChatRoute(row.route) } : null;
}

/** 0064 PR2: record the active outline step assigned to a child. */
export function setConversationWorkStep(db: Db, id: string, step: string): void {
  db.update(conversations).set({ workStep: step }).where(eq(conversations.id, id)).run();
}

/** 0021: set (or clear, with null) the conversation's route — the chat
 *  picker's choice. The sandbox binding is set once, through
 *  db/sandboxes.ts. Caller validates. */
export function setConversationRoute(db: Db, id: string, route: ChatRoute | null): void {
  db.update(conversations)
    .set({ route: route ? JSON.stringify(route) : null })
    .where(eq(conversations.id, id))
    .run();
}

/** 0043 amendment: this chat's exec-approval toggle (false = always ask,
 *  the default). Absent conversation reads as off. */
export function getHostAutoApprove(db: Db, id: string): boolean {
  return !!db
    .select({ v: conversations.hostAutoApprove })
    .from(conversations)
    .where(eq(conversations.id, id))
    .get()?.v;
}

/** 0043 amendment: set the chat's exec-approval toggle (the composer's
 *  switch — stays on until turned off, no time limit). */
export function setHostAutoApprove(db: Db, id: string, value: boolean): void {
  db.update(conversations).set({ hostAutoApprove: value }).where(eq(conversations.id, id)).run();
}

/** 0037 phase 3: a chat another chat started (start_thread) — the wake
 *  read model. `updatedAt` is the settle reference: it moves with every
 *  persisted message, so "settled" = no live turn and updates the parent
 *  has not been told about. */
export interface ChatChild {
  id: string;
  parentConversationId: string | null;
  /** 0064 PR2: active outline step this child was spawned to do. */
  workStep: string | null;
  activeRunId: string | null;
  trashedAt: number | null;
  createdAt: number;
  updatedAt: number;
  wokenSettledAt: number | null;
}

const chatChildColumns = {
  id: conversations.id,
  parentConversationId: conversations.parentConversationId,
  workStep: conversations.workStep,
  activeRunId: conversations.activeRunId,
  trashedAt: conversations.trashedAt,
  createdAt: conversations.createdAt,
  updatedAt: conversations.updatedAt,
  wokenSettledAt: conversations.wokenSettledAt,
};

export function getChatChild(db: Db, id: string): ChatChild | null {
  return db.select(chatChildColumns).from(conversations).where(eq(conversations.id, id)).get() ?? null;
}

/** Children with an undelivered settle — the wake sweep's input. */
export function listWakableChatChildren(db: Db): ChatChild[] {
  return db
    .select(chatChildColumns)
    .from(conversations)
    .where(
      sql`${conversations.parentConversationId} is not null
          and (${conversations.wokenSettledAt} is null
               or ${conversations.wokenSettledAt} < ${conversations.updatedAt})`,
    )
    .all();
}

/** Record the parent (start_thread) and pre-stamp woken to the row's
 *  current updatedAt — the creation bump is not a settle, so the wake
 *  fires only once the child's turn actually lands messages. 0046 locked
 *  groups: the child also copies the parent's folder at creation, so a
 *  group never diverges at the source. */
export function setConversationParent(db: Db, id: string, parentConversationId: string): void {
  const row = db.select({ updatedAt: conversations.updatedAt }).from(conversations).where(eq(conversations.id, id)).get();
  if (!row) throw new Error(`no conversation ${id}`);
  const parent = db
    .select({ folderId: conversations.folderId })
    .from(conversations)
    .where(eq(conversations.id, parentConversationId))
    .get();
  if (!parent) throw new Error(`no conversation ${parentConversationId}`);
  db.update(conversations)
    .set({ parentConversationId, folderId: parent.folderId, wokenSettledAt: row.updatedAt })
    .where(eq(conversations.id, id))
    .run();
}

/** `resultFile` is the path `saveResultFile` actually wrote for THIS
 *  settle, or null — review fix (0040 phase 3): every settle (including
 *  one with nothing to report) overwrites it, so it never outlives the
 *  settle it describes; `inspect` reads it verbatim instead of guessing. */
export function markChatChildWoken(db: Db, id: string, at: number, resultFile: string | null = null): void {
  db.update(conversations).set({ wokenSettledAt: at, resultFile }).where(eq(conversations.id, id)).run();
}

/** Strip `[tool <name>]` placeholder tokens (textOf's stand-in for a
 *  tool-call with no text, workflows/chat/steps.ts) and surrounding
 *  whitespace — what is left is "real" text, if anything is. */
export { stripToolPlaceholders };

/** A malformed metadata blob (legacy/imported data) must never throw
 *  inside a wake — at turn-end that is wakeParentStep, inside the
 *  child's own turn workflow. Review fix: not exhausted beats a crash. */
function safeParseMetadata(raw: string | null): MessageRowMetadata | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MessageRowMetadata;
  } catch {
    return null;
  }
}

/** A generous ceiling on how many of a child's assistant rows
 *  `lastAssistantReport` ever scans — review fix: an unbounded select ran
 *  on every due-wake check (including the 30 s sweep), and a 400-step
 *  thread with a placeholder-only tail or no report at all scanned its
 *  entire history every time. Far past any real turn's assistant-row
 *  count; only a pathological thread would ever hit it. */
const LAST_ASSISTANT_REPORT_SCAN_LIMIT = 1_000;

/** A child's most recent real report: the newest assistant row with text
 *  that isn't only `[tool …]` placeholders, and whether the NEWEST
 *  assistant row overall (which may be a later, textless placeholder)
 *  was marked exhausted (0040 phase 3: the turn hit its step budget
 *  mid-tool-call rather than the model choosing to stop). */
export interface AssistantReport {
  text: string;
  exhausted: boolean;
}

/** The child's last REAL assistant report — the wake's detail (a review
 *  thread's findings). Null when it never produced any real text (a
 *  turn that died before its first slice, or ran out of steps on its
 *  very first, placeholder-only step). */
export function lastAssistantReport(db: Db, conversationId: string): AssistantReport | null {
  const rows = db
    .select({ text: messages.text, metadata: messages.metadata })
    .from(messages)
    .where(sql`${messages.conversationId} = ${conversationId} and ${messages.role} = 'assistant'`)
    .orderBy(sql`rowid desc`)
    .limit(LAST_ASSISTANT_REPORT_SCAN_LIMIT)
    .all();
  if (rows.length === 0) return null;
  const newest = safeParseMetadata(rows[0]!.metadata);
  const exhausted = newest?.exhausted === true;
  for (const row of rows) {
    const text = stripToolPlaceholders(row.text);
    if (text) return { text, exhausted };
  }
  return null;
}
