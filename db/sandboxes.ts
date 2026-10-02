import { and, asc, desc, eq, lt, ne, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "./index";
import { sandboxAttachments, sandboxCalls, sandboxes } from "./schema";

/**
 * 0010 Phase 2 sandbox lease store. The `sandboxes` table is a registry
 * of live leases (rows are deleted on destroy — history lives in run and
 * harness tables); every invariant about ownership, status, and idle
 * age lives here so routes, the lease layer, and the reaper agree.
 */

export type SandboxOwnerKind = "conversation" | "machine_run";
export type SandboxLeaseStatus = "creating" | "running" | "stopped" | "destroyed";

export interface SandboxLease {
  id: string;
  provider: string;
  ref: string;
  ownerKind: SandboxOwnerKind;
  ownerId: string;
  projectId: string | null;
  status: SandboxLeaseStatus;
  lastUsedAt: number;
  createdAt: number;
  /** 0011: set when destroyed; the row stays as history. */
  destroyedAt: number | null;
}

type SandboxRow = typeof sandboxes.$inferSelect;

function hydrate(row: SandboxRow): SandboxLease {
  return {
    id: row.id,
    provider: row.provider,
    ref: row.ref,
    ownerKind: row.ownerKind as SandboxLease["ownerKind"],
    ownerId: row.ownerId,
    projectId: row.projectId,
    status: row.status as SandboxLease["status"],
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    destroyedAt: row.destroyedAt,
  };
}

/** Insert a "creating" lease; throws on owner conflicts (unique index). */
export function insertLease(
  db: Db,
  input: {
    provider: string;
    ownerKind: SandboxOwnerKind;
    ownerId: string;
    projectId: string | null;
  },
): SandboxLease {
  const now = Date.now();
  const row = {
    id: `sbx_${nanoid()}`,
    provider: input.provider,
    // Placeholder until the provider reports its ref; never acquired in
    // this state (updateLeaseRef flips it to running first).
    ref: "",
    ownerKind: input.ownerKind,
    ownerId: input.ownerId,
    projectId: input.projectId,
    status: "creating" as const,
    lastUsedAt: now,
    createdAt: now,
    destroyedAt: null,
  };
  db.insert(sandboxes).values(row).run();
  return hydrate(row);
}

/** The owner's live dedicated lease, if one exists (destroyed rows are history). */
export function getLeaseByOwner(
  db: Db,
  ownerKind: SandboxOwnerKind,
  ownerId: string,
): SandboxLease | null {
  const row = db
    .select()
    .from(sandboxes)
    .where(
      and(
        eq(sandboxes.ownerKind, ownerKind),
        eq(sandboxes.ownerId, ownerId),
        ne(sandboxes.status, "destroyed"),
      ),
    )
    .get();
  return row ? hydrate(row) : null;
}

export function getLease(db: Db, id: string): SandboxLease | null {
  const row = db.select().from(sandboxes).where(eq(sandboxes.id, id)).get();
  return row ? hydrate(row) : null;
}

export function updateLease(
  db: Db,
  id: string,
  set: Partial<Pick<SandboxLease, "ref" | "status">>,
): void {
  db.update(sandboxes).set(set).where(eq(sandboxes.id, id)).run();
}

export function touchLease(db: Db, id: string): void {
  db.update(sandboxes)
    .set({ lastUsedAt: Date.now() })
    .where(eq(sandboxes.id, id))
    .run();
}

/**
 * Remove a lease that never became usable (a failed create). Real
 * teardown is `markDestroyed` — the row must outlive the sandbox so
 * recorded calls keep pointing at it.
 */
export function deleteLease(db: Db, id: string): void {
  db.delete(sandboxAttachments).where(eq(sandboxAttachments.sandboxId, id)).run();
  db.delete(sandboxes).where(eq(sandboxes.id, id)).run();
}

/** 0011: soft-destroy — status flips, the row and its attachments stay. */
export function markDestroyed(db: Db, id: string): void {
  db.update(sandboxes)
    .set({ status: "destroyed", destroyedAt: Date.now() })
    .where(eq(sandboxes.id, id))
    .run();
}

/** Leases whose last use is older than `before` (the reaper's input). */
export function listIdleLeases(db: Db, before: number): SandboxLease[] {
  return db
    .select()
    .from(sandboxes)
    .where(
      and(
        lt(sandboxes.lastUsedAt, before),
        or(eq(sandboxes.status, "running"), eq(sandboxes.status, "stopped")),
      ),
    )
    .all()
    .map(hydrate);
}

/** Record (or refresh) a conversation's attachment to a sandbox. */
export function upsertAttachment(
  db: Db,
  input: { sandboxId: string; conversationId: string; workdir: string },
): void {
  db.insert(sandboxAttachments)
    .values({ ...input, createdAt: Date.now() })
    .onConflictDoUpdate({
      set: { workdir: input.workdir },
      target: [sandboxAttachments.sandboxId, sandboxAttachments.conversationId],
    })
    .run();
}

/** The conversation's current attachment, if any. */
export function getAttachmentByConversation(
  db: Db,
  conversationId: string,
): { sandboxId: string; workdir: string } | null {
  const row = db
    .select({ sandboxId: sandboxAttachments.sandboxId, workdir: sandboxAttachments.workdir })
    .from(sandboxAttachments)
    .where(eq(sandboxAttachments.conversationId, conversationId))
    .get();
  return row ?? null;
}

/** 0011: one sandboxed tool call's attribution row. */
export interface SandboxCall {
  toolCallId: string;
  sandboxId: string;
  conversationId: string;
  tool: "bash" | "pi" | "claude";
  via: "dedicated" | "attached";
  workdir: string;
  at: number;
}

/**
 * Record the sandbox a tool call actually ran in. Idempotent on
 * toolCallId (a step retry re-records the same call), keeping the first
 * row's timestamp.
 */
export function recordSandboxCall(db: Db, call: Omit<SandboxCall, "at">): void {
  db.insert(sandboxCalls)
    .values({ ...call, at: Date.now() })
    .onConflictDoUpdate({
      target: sandboxCalls.toolCallId,
      set: { sandboxId: call.sandboxId, via: call.via, workdir: call.workdir },
    })
    .run();
}

export function listCallsForConversation(db: Db, conversationId: string): SandboxCall[] {
  return db
    .select()
    .from(sandboxCalls)
    .where(eq(sandboxCalls.conversationId, conversationId))
    // rowid breaks ties between calls recorded in the same millisecond, so
    // "previous call" (the switched flag) is insertion order, not luck.
    .orderBy(asc(sandboxCalls.at), asc(sql`rowid`))
    .all() as SandboxCall[];
}

export function listCallsForSandbox(db: Db, sandboxId: string): SandboxCall[] {
  return db
    .select()
    .from(sandboxCalls)
    .where(eq(sandboxCalls.sandboxId, sandboxId))
    .orderBy(desc(sandboxCalls.at), desc(sql`rowid`))
    .all() as SandboxCall[];
}
