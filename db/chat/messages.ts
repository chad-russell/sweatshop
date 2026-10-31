import { asc, eq, sql } from "drizzle-orm";
import type { ModelMessage } from "ai";
import { viewingNote, type ViewingContext } from "../../lib/page-context";
import type { ChatRoute, RouteLayer } from "../../lib/providers/route";
import type { Db } from "../index";
import { conversations, messages } from "../schema";

/**
 * 0010 spike store: message persistence. `messages` rows with a
 * serialized ModelMessage are the source of truth for a conversation's
 * history (the eve event mirror these once coexisted with was retired
 * by 0032).
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
  /** 0055/0059: on a turn's user row — the turn's RENDERED `[thread
   *  state]` note text (lib/status.ts's `renderThreadStateNote`,
   *  already computed when this row was written). `listTurnMessages`
   *  replays it verbatim right before this row on every later turn, so
   *  history byte-matches what this turn actually saw (the prompt-cache
   *  prefix holds instead of invalidating every turn) without
   *  re-deriving the outline (lib/outline.ts `renderThreadStateNote`). */
  threadState?: string;
  /** 0091 §3: on a turn's user row — the skill ids attached to that
   * send (transcript chips). The ids are facts about the row; the
   * RENDERED section below is what the model saw, replayed verbatim. */
  attachedSkills?: string[];
  /** 0091 §3: the rendered `# Attached skills` section this turn's
   * model input carried, stored pre-rendered (like threadState) so
   * listTurnMessages replays it byte-identical — the skill bodies may
   * change in the store later, but history must not. */
  attachedSkillsNote?: string;
  /** 0040 phase 3: on the turn's LAST assistant row — the turn ended by
   *  hitting its step budget, not by the model choosing to stop (so that
   *  row's text is often just a dangling `[tool …]` placeholder). Durable
   *  so the sweep path sees it too, not only the in-run wake. */
  exhausted?: boolean;
}

/** 0022: what woke a conversation (machine run or harness call; 0037:
 *  "budget" = LEGACY (0088 removed budget continuation; old chips still render);
 *  "thread" = a child chat started by start_thread settled; 0041:
 *  "plan" = Chad approved the plan under review; 0055: "mode" = the
 *  owner's send entered a mode — this row's TEXT is the mode's
 *  rendered intro + first-phase runbook, not a wake; 0064: "outline" =
 *  Chad approved the outline under review; 0082: "loop" = the same tool
 *  call (name + input + result) repeated 3 times in one turn — the
 *  row's text is the runtime's own nudge, injected mid-turn like a
 *  steer message, never Chad's words); 0084: "pr" = a watched PR the
 *  chat opened merged or closed on its host (id = the pr_watches row). */
export interface RunEventMeta {
  kind:
    | "machine"
    | "harness"
    | "budget"
    | "thread"
    | "plan"
    | "mode"
    | "outline"
    | "outline-edit"
    | "loop"
    | "pr";
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
 * message's viewing note, then its thread-state note (0055), then its
 * attached-skills section (0091 §3), injected as user-role messages
 * right before it — so a later turn still knows
 * what "this" was and what mode/phase that turn ran in. (The agent
 * forbids system messages in `messages`.) Both notes live as row
 * metadata, never as text; this is the only place they become
 * model-visible, and persistTurn's skip keeps the current turn's own
 * copies out of the store (they are rebuilt here instead — the same
 * messages byte-for-byte, so the prompt-cache prefix holds).
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
    const metadata = row.metadata ? (JSON.parse(row.metadata) as MessageRowMetadata) : undefined;
    if (metadata?.viewing) out.push({ role: "user", content: viewingNote(metadata.viewing) });
    if (metadata?.threadState) out.push({ role: "user", content: metadata.threadState });
    if (metadata?.attachedSkillsNote) out.push({ role: "user", content: metadata.attachedSkillsNote });
    out.push(JSON.parse(row.modelMessage!) as ModelMessage);
  }
  return out;
}

/** Simple {role, text} view of a message row (reload/initial render). */
export interface MessageTextRow {
  id: string;
  role: string;
  text: string;
  at: number;
  modelMessage: ModelMessage | null;
  metadata: MessageRowMetadata | null;
}

/** A page of message rows plus the cursor for the rows older than it. */
export interface MessageTextsPage {
  /** The page's rows, oldest-first (same shape listMessageTexts returns). */
  rows: MessageTextRow[];
  /** rowid of the page's first row, when older rows remain — the
   *  `before` cursor for the previous page. Null = start of
   *  conversation (or an empty page: nothing older to load either way). */
  olderCursor: number | null;
  /** How many qualifying rows sit before the cursor (the "~N more" the
   *  load-earlier control shows). */
  olderRemaining: number;
}

/**
 * One lineage: once a conversation has model_message rows (new runtime
 * or imported), older text-only rows are superseded. The filter must
 * apply to page queries AND the older-rows count alike, or `tail`
 * stranding pre-0010 rows at the bottom of the table.
 */
function messageTextsWhere(db: Db, conversationId: string, before?: number): ReturnType<typeof sql> {
  const hasModelRows = db
    .select({ one: sql`1` })
    .from(messages)
    .where(sql`${messages.conversationId} = ${conversationId} and ${messages.modelMessage} is not null`)
    .limit(1)
    .get();
  return sql`${messages.conversationId} = ${conversationId}
      and ${hasModelRows ? sql`${messages.modelMessage} is not null` : sql`true`}
      ${before != null ? sql`and rowid < ${before}` : sql``}`;
}

/**
 * `listMessageTexts` with a tail/before cursor: `tail` = the newest N
 * rows (oldest-first), `before` = start strictly below that rowid. No
 * opts = every row, exactly what `listMessageTexts` has always
 * returned. Rows order by rowid (insertion order) — the plan's cursor,
 * with no schema change.
 */
export function listMessageTextsPage(
  db: Db,
  conversationId: string,
  opts: { tail?: number; before?: number } = {},
): MessageTextsPage {
  const where = messageTextsWhere(db, conversationId, opts.before);
  const select = {
    id: messages.id,
    role: messages.role,
    text: messages.text,
    at: messages.at,
    modelMessage: messages.modelMessage,
    metadata: messages.metadata,
    rowid: sql<number>`rowid`,
  };
  // tail pages read the newest rows first, then reverse to oldest-first.
  const raw =
    opts.tail != null
      ? db.select(select).from(messages).where(where).orderBy(sql`rowid desc`).limit(opts.tail).all()
      : db.select(select).from(messages).where(where).orderBy(asc(sql`rowid`)).all();
  if (opts.tail != null) raw.reverse();
  const parse = (row: (typeof raw)[number]): MessageTextRow => ({
    id: row.id,
    role: row.role,
    text: row.text,
    at: row.at,
    modelMessage: row.modelMessage ? (JSON.parse(row.modelMessage) as ModelMessage) : null,
    metadata: row.metadata ? (JSON.parse(row.metadata) as MessageRowMetadata) : null,
  });
  if (raw.length === 0) return { rows: [], olderCursor: null, olderRemaining: 0 };
  const first = raw[0]!.rowid;
  const olderRemaining =
    db
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .where(messageTextsWhere(db, conversationId, first))
      .get()?.n ?? 0;
  return {
    rows: raw.map(parse),
    olderCursor: olderRemaining > 0 ? first : null,
    olderRemaining,
  };
}

/** Simple {role, text} view of every message row (reload/initial render;
 *  full history — the model prompt path and inspect keep this shape). */
export function listMessageTexts(db: Db, conversationId: string): MessageTextRow[] {
  return listMessageTextsPage(db, conversationId).rows;
}
