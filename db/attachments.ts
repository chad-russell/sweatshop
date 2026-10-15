import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import type { Db } from "./index";

/** A db handle or an open transaction (the teardown runs in one). */
type Conn = Pick<Db, "select" | "delete">;
import { attachments } from "./schema";

/**
 * 0042: attachment rows. An upload is unclaimed (`conversation_id` null)
 * until a send claims it; unclaimed rows past the TTL are swept with
 * their files (the caller deletes files — this layer is rows only).
 */

export const UNCLAIMED_TTL_MS = 24 * 60 * 60 * 1000;

export type AttachmentRow = typeof attachments.$inferSelect;

export function insertAttachment(
  db: Db,
  row: { id: string; mediaType: string; bytes: number },
  now: number = Date.now(),
): void {
  db.insert(attachments).values({ ...row, conversationId: null, createdAt: now }).run();
}

export function getAttachments(db: Db, ids: readonly string[]): AttachmentRow[] {
  if (ids.length === 0) return [];
  return db.select().from(attachments).where(inArray(attachments.id, [...ids])).all();
}

export type ClaimResult =
  | { ok: true; rows: AttachmentRow[] }
  | { ok: false; error: string };

/**
 * Validate a send's attachment ids for a conversation: each must exist
 * and be unclaimed or already this conversation's (a retried send). Pure
 * read — `claimAttachments` writes.
 */
export function checkClaimable(db: Db, ids: readonly string[], conversationId: string): ClaimResult {
  const rows = getAttachments(db, ids);
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) return { ok: false, error: `unknown attachment ${id}` };
    if (row.conversationId && row.conversationId !== conversationId) {
      return { ok: false, error: `attachment ${id} belongs to another conversation` };
    }
  }
  return { ok: true, rows: ids.map((id) => byId.get(id)!) };
}

/** Bind unclaimed attachments to the conversation (idempotent). */
export function claimAttachments(db: Db, ids: readonly string[], conversationId: string): void {
  if (ids.length === 0) return;
  db.update(attachments)
    .set({ conversationId })
    .where(and(inArray(attachments.id, [...ids]), isNull(attachments.conversationId)))
    .run();
}

/** Delete unclaimed rows older than the TTL; returns their ids. */
export function sweepUnclaimed(db: Db, now: number = Date.now()): string[] {
  const stale = db
    .select({ id: attachments.id })
    .from(attachments)
    .where(and(isNull(attachments.conversationId), lt(attachments.createdAt, now - UNCLAIMED_TTL_MS)))
    .all()
    .map((r) => r.id);
  if (stale.length > 0) db.delete(attachments).where(inArray(attachments.id, stale)).run();
  return stale;
}

/** Delete a conversation's rows (inside its teardown transaction); returns ids. */
export function deleteConversationAttachments(db: Conn, conversationId: string): string[] {
  const ids = db
    .select({ id: attachments.id })
    .from(attachments)
    .where(eq(attachments.conversationId, conversationId))
    .all()
    .map((r) => r.id);
  if (ids.length > 0) db.delete(attachments).where(eq(attachments.conversationId, conversationId)).run();
  return ids;
}
