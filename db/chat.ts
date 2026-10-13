import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { ModelMessage } from "ai";
import { viewingNote, type ViewingContext } from "../lib/page-context";
import type { ChatRoute, RouteLayer } from "../lib/providers/route";
import type { Db } from "./index";
import { parseStoredChatRoute } from "./providers";
import {
  chatHarnessState,
  conversations,
  messages,
  pendingInputs,
  steerQueue,
} from "./schema";

/**
 * 0010 spike store: the new chat runtime's own tables. The source of
 * truth is `messages` rows with a serialized ModelMessage (the eve
 * event mirror these once coexisted with was retired by 0032).
 *
 * Rows are append-only and read back in insertion order (rowid); ids are
 * content-stable per turn so step retries cannot duplicate them.
 */

/** 0015: per-row metadata — the viewing context of a user message. */
export interface MessageRowMetadata {
  viewing?: ViewingContext;
  /** 0021: on a turn's first assistant row — what ran it, and which
   *  layer the route resolved from. */
  route?: { route: ChatRoute; layer: RouteLayer };
  /** 0022: on a wake message — the child that settled (rendered as a
   *  transcript chip, never read back as model input; the text IS the
   *  model input). */
  runEvent?: RunEventMeta;
}

/** 0022: what woke a conversation (machine run or harness call; 0037:
 *  "budget" = a thread-skill turn hit its step budget and continues;
 *  "thread" = a child chat started by start_thread settled; 0041:
 *  "plan" = Chad approved the plan under review). */
export interface RunEventMeta {
  kind: "machine" | "harness" | "budget" | "thread" | "plan";
  id: string;
  status: string;
}

export interface NewMessageRow {
  id: string;
  role: "user" | "assistant" | "tool";
  /** Plain-text extraction (search/display fallback). */
  text: string;
  /** The ModelMessage this row persists. */
  modelMessage: ModelMessage;
  /** 0015: the send's page-viewing context (user rows; the note is
   *  rebuilt for the model from this, never stored as text). */
  metadata?: MessageRowMetadata;
}

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
  /** 0039: the thread's skill id (null = plain chat). */
  skill: string | null;
} | null {
  const row = db
    .select({
      id: conversations.id,
      projectId: conversations.projectId,
      route: conversations.route,
      trashedAt: conversations.trashedAt,
      skill: conversations.skill,
    })
    .from(conversations)
    .where(eq(conversations.id, id))
    .get();
  return row ? { ...row, route: parseStoredChatRoute(row.route) } : null;
}

/** 0039: set the thread's skill (creation send, or use_skill). */
export function setConversationSkill(db: Db, id: string, skill: string): void {
  db.update(conversations).set({ skill }).where(eq(conversations.id, id)).run();
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

/**
 * 0010 Phase 3b: a conversation × harness's `resumeFrom` handle — the
 * durable session continuity for harness tool calls (next call resumes
 * the same harness session with prior context).
 */
export function getHarnessResumeState(
  db: Db,
  conversationId: string,
  harness: string,
): unknown | null {
  const row = db
    .select({ resumeFrom: chatHarnessState.resumeFrom })
    .from(chatHarnessState)
    .where(
      sql`${chatHarnessState.conversationId} = ${conversationId} and ${chatHarnessState.harness} = ${harness}`,
    )
    .get();
  return row ? (JSON.parse(row.resumeFrom) as unknown) : null;
}

export function saveHarnessResumeState(
  db: Db,
  conversationId: string,
  harness: string,
  resumeFrom: unknown,
): void {
  db.insert(chatHarnessState)
    .values({
      conversationId,
      harness,
      resumeFrom: JSON.stringify(resumeFrom),
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      set: { resumeFrom: JSON.stringify(resumeFrom), updatedAt: Date.now() },
      target: [chatHarnessState.conversationId, chatHarnessState.harness],
    })
    .run();
}

/**
 * 0010 Phase 4: pending human input on the new chat runtime. The tool
 * records the request before awaiting its hook; the resume route marks
 * it answered. The inbox reads unresolved rows.
 */
export function recordPendingInput(
  db: Db,
  input: { id: string; conversationId: string; kind: string; question: string; card?: unknown },
): void {
  const { card, ...row } = input;
  db.insert(pendingInputs)
    .values({ ...row, card: card === undefined ? null : JSON.stringify(card), createdAt: Date.now() })
    .onConflictDoNothing()
    .run();
}

export function resolvePendingInput(
  db: Db,
  id: string,
  answer: unknown,
): void {
  db.update(pendingInputs)
    .set({ resolvedAt: Date.now(), answer: JSON.stringify(answer) })
    .where(eq(pendingInputs.id, id))
    .run();
}

/**
 * Resolve every unresolved non-plan pending input of a conversation
 * whose turn can no longer resume: the hook died with its run
 * (cancelled, failed, expired — a resume is "Hook not found"), so the
 * inbox card must not outlive it (2026-10-13: two stuck PR approvals
 * had no working button). Plan reviews are hookless (0041) and stay.
 * `reason` lands in the row's answer for the record. Returns the ids
 * cleared — an empty list means nothing was orphaned.
 */
export function resolveOrphanedPendingInputs(
  db: Db,
  conversationId: string,
  reason: string,
): string[] {
  const ids = db
    .select({ id: pendingInputs.id })
    .from(pendingInputs)
    .where(
      and(
        eq(pendingInputs.conversationId, conversationId),
        isNull(pendingInputs.resolvedAt),
        ne(pendingInputs.kind, "plan"),
      ),
    )
    .all()
    .map((row) => row.id);
  if (ids.length > 0) {
    db.update(pendingInputs)
      .set({ resolvedAt: Date.now(), answer: JSON.stringify({ orphaned: reason }) })
      .where(and(inArray(pendingInputs.id, ids), isNull(pendingInputs.resolvedAt)))
      .run();
  }
  return ids;
}

/** 0037: a pending input's runtime-built card evidence (null = none,
 *  or no such row). */
export function getPendingInputCard(db: Db, id: string): unknown {
  const row = db.select({ card: pendingInputs.card }).from(pendingInputs).where(eq(pendingInputs.id, id)).get();
  if (!row?.card) return null;
  try {
    return JSON.parse(row.card) as unknown;
  } catch {
    return null;
  }
}

export function listPendingInputs(
  db: Db,
  conversationId?: string,
): {
  id: string;
  conversationId: string;
  kind: string;
  question: string;
  createdAt: number;
}[] {
  const where = conversationId
    ? sql`${pendingInputs.conversationId} = ${conversationId} and ${pendingInputs.resolvedAt} is null`
    : sql`${pendingInputs.resolvedAt} is null`;
  return db
    .select({
      id: pendingInputs.id,
      conversationId: pendingInputs.conversationId,
      kind: pendingInputs.kind,
      question: pendingInputs.question,
      createdAt: pendingInputs.createdAt,
    })
    .from(pendingInputs)
    .where(where)
    .orderBy(asc(pendingInputs.createdAt))
    .all();
}

/** Append message rows for one conversation (order = insertion order). */
export function appendMessages(
  db: Db,
  conversationId: string,
  rows: NewMessageRow[],
): void {
  if (rows.length === 0) return;
  const at = Date.now();
  db.insert(messages)
    .values(
      rows.map((row) => ({
        id: row.id,
        conversationId,
        role: row.role,
        text: row.text,
        modelMessage: JSON.stringify(row.modelMessage),
        metadata: row.metadata ? JSON.stringify(row.metadata) : null,
        at,
      })),
    )
    .onConflictDoNothing()
    .run();
  db.update(conversations)
    .set({ updatedAt: at })
    .where(eq(conversations.id, conversationId))
    .run();
}

/** The conversation's persisted model history, in insertion order. */
export function listModelMessages(db: Db, conversationId: string): ModelMessage[] {
  const rows = db
    .select({ modelMessage: messages.modelMessage, role: messages.role, text: messages.text })
    .from(messages)
    .where(sql`${messages.conversationId} = ${conversationId} and ${messages.modelMessage} is not null`)
    .orderBy(asc(sql`rowid`))
    .all();
  return rows.map((row) => JSON.parse(row.modelMessage!) as ModelMessage);
}

/**
 * The turn's model input (0015): the persisted history with each user
 * message's viewing note injected as a user-role message before it —
 * so a later turn still knows what "this" was. (The agent forbids
 * system messages in `messages`.) Notes live as row metadata; this is
 * the only place they become model-visible text, and persistTurn's
 * skip keeps the current turn's note out of the store.
 */
export function listTurnMessages(db: Db, conversationId: string): ModelMessage[] {
  const rows = db
    .select({ modelMessage: messages.modelMessage, metadata: messages.metadata })
    .from(messages)
    .where(sql`${messages.conversationId} = ${conversationId} and ${messages.modelMessage} is not null`)
    .orderBy(asc(sql`rowid`))
    .all();
  const out: ModelMessage[] = [];
  for (const row of rows) {
    const viewing = row.metadata
      ? (JSON.parse(row.metadata) as MessageRowMetadata).viewing
      : undefined;
    if (viewing) out.push({ role: "user", content: viewingNote(viewing) });
    out.push(JSON.parse(row.modelMessage!) as ModelMessage);
  }
  return out;
}

/** Simple {role, text} view of every message row (reload/initial render). */
export function listMessageTexts(
  db: Db,
  conversationId: string,
): {
  id: string;
  role: string;
  text: string;
  at: number;
  modelMessage: ModelMessage | null;
  metadata: MessageRowMetadata | null;
}[] {
  const rows = db
    .select({
      id: messages.id,
      role: messages.role,
      text: messages.text,
      at: messages.at,
      modelMessage: messages.modelMessage,
      metadata: messages.metadata,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(sql`rowid`))
    .all()
    .map((row) => ({
      ...row,
      modelMessage: row.modelMessage ? (JSON.parse(row.modelMessage) as ModelMessage) : null,
      metadata: row.metadata ? (JSON.parse(row.metadata) as MessageRowMetadata) : null,
    }));
  // One lineage: once a conversation has model_message rows (new
  // runtime or imported), older text-only rows are superseded.
  if (rows.some((row) => row.modelMessage != null)) {
    return rows.filter((row) => row.modelMessage != null);
  }
  return rows;
}

/** Queue a steer message for a conversation with a live turn. */
export function enqueueSteer(db: Db, conversationId: string, text: string): void {
  db.insert(steerQueue)
    .values({
      id: `s_${conversationId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      conversationId,
      text,
      createdAt: Date.now(),
    })
    .run();
}

/** Steer texts for a conversation, oldest first, WITHOUT consuming them. */
export function peekSteer(db: Db, conversationId: string): string[] {
  return db
    .select({ text: steerQueue.text })
    .from(steerQueue)
    .where(eq(steerQueue.conversationId, conversationId))
    .orderBy(asc(sql`rowid`))
    .all()
    .map((row) => row.text);
}

/** Consume the steer queue (mid-turn drain / next-turn fold). */
export function drainSteer(db: Db, conversationId: string): string[] {
  const texts = peekSteer(db, conversationId);
  if (texts.length > 0) {
    db.delete(steerQueue)
      .where(eq(steerQueue.conversationId, conversationId))
      .run();
  }
  return texts;
}

/** Record which turn workflow run is live for this conversation. */
export function setActiveRun(db: Db, conversationId: string, runId: string | null): void {
  db.update(conversations)
    .set({ activeRunId: runId })
    .where(eq(conversations.id, conversationId))
    .run();
}

/** Clear the active run only if it still points at `runId`. */
export function clearActiveRunIfMatches(db: Db, conversationId: string, runId: string): void {
  db.update(conversations)
    .set({ activeRunId: null })
    .where(
      sql`${conversations.id} = ${conversationId} and ${conversations.activeRunId} = ${runId}`,
    )
    .run();
}

export function getActiveRun(db: Db, conversationId: string): string | null {
  const row = db
    .select({ activeRunId: conversations.activeRunId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  return row?.activeRunId ?? null;
}

/** 0037 phase 3: a chat another chat started (start_thread) — the wake
 *  read model. `updatedAt` is the settle reference: it moves with every
 *  persisted message, so "settled" = no live turn and updates the parent
 *  has not been told about. */
export interface ChatChild {
  id: string;
  parentConversationId: string | null;
  skill: string | null;
  activeRunId: string | null;
  trashedAt: number | null;
  createdAt: number;
  updatedAt: number;
  wokenSettledAt: number | null;
}

const chatChildColumns = {
  id: conversations.id,
  parentConversationId: conversations.parentConversationId,
  skill: conversations.skill,
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
 *  fires only once the child's turn actually lands messages. */
export function setConversationParent(db: Db, id: string, parentConversationId: string): void {
  const row = db.select({ updatedAt: conversations.updatedAt }).from(conversations).where(eq(conversations.id, id)).get();
  if (!row) throw new Error(`no conversation ${id}`);
  db.update(conversations)
    .set({ parentConversationId, wokenSettledAt: row.updatedAt })
    .where(eq(conversations.id, id))
    .run();
}

export function markChatChildWoken(db: Db, id: string, at: number): void {
  db.update(conversations).set({ wokenSettledAt: at }).where(eq(conversations.id, id)).run();
}

/** The child's last assistant text — the wake's detail (a review
 *  thread's findings). Null when it never produced output. */
export function lastAssistantText(db: Db, conversationId: string): string | null {
  const row = db
    .select({ text: messages.text })
    .from(messages)
    .where(sql`${messages.conversationId} = ${conversationId} and ${messages.role} = 'assistant'`)
    .orderBy(sql`rowid desc`)
    .limit(1)
    .get();
  return row?.text ?? null;
}
