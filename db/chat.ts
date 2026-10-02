import { asc, eq, sql } from "drizzle-orm";
import type { ModelMessage } from "ai";
import type { Db } from "./index";
import {
  chatHarnessState,
  conversations,
  messages,
  pendingInputs,
  steerQueue,
} from "./schema";

/**
 * 0010 spike store: the new chat runtime's own tables. The mirror
 * (db/mirror.ts) keeps writing eve conversations exactly as before; these
 * helpers serve `/x` conversations whose source of truth is `messages`
 * rows with a serialized ModelMessage, not the event mirror.
 *
 * Rows are append-only and read back in insertion order (rowid); ids are
 * content-stable per turn so step retries cannot duplicate them.
 */

export interface NewMessageRow {
  id: string;
  role: "user" | "assistant" | "tool";
  /** Plain-text extraction (search/display fallback). */
  text: string;
  /** The ModelMessage this row persists. */
  modelMessage: ModelMessage;
}

/** Create the conversation row if absent (new-runtime ids: `c_…`). */
export function ensureConversation(
  db: Db,
  id: string,
  projectId: string | null = null,
): void {
  const now = Date.now();
  db.insert(conversations)
    .values({ id, projectId, createdAt: now, updatedAt: now })
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
  modelId: string | null;
  sandboxPref: string | null;
} | null {
  const row = db
    .select({
      id: conversations.id,
      projectId: conversations.projectId,
      modelId: conversations.modelId,
      sandboxPref: conversations.sandboxPref,
    })
    .from(conversations)
    .where(eq(conversations.id, id))
    .get();
  return row ?? null;
}

/** 0010: update the conversation's explicit knobs (model, sandbox pref). */
export function updateConversationSettings(
  db: Db,
  id: string,
  set: { modelId?: string; sandboxPref?: string | null },
): void {
  if (Object.keys(set).length === 0) return;
  db.update(conversations).set(set).where(eq(conversations.id, id)).run();
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
  input: { id: string; conversationId: string; kind: string; question: string },
): void {
  db.insert(pendingInputs)
    .values({ ...input, createdAt: Date.now() })
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
}[] {
  const rows = db
    .select({
      id: messages.id,
      role: messages.role,
      text: messages.text,
      at: messages.at,
      modelMessage: messages.modelMessage,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(sql`rowid`))
    .all()
    .map((row) => ({
      ...row,
      modelMessage: row.modelMessage ? (JSON.parse(row.modelMessage) as ModelMessage) : null,
    }));
  // One lineage: once a conversation has model_message rows (new
  // runtime or imported), older mirror-extracted rows are superseded.
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
