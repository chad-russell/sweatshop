import { and, eq, lt, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "./index";
import { sandboxAttachments, sandboxes } from "./schema";

/**
 * 0010 Phase 2 sandbox lease store. The `sandboxes` table is a registry
 * of live leases (rows are deleted on destroy — history lives in run and
 * harness tables); every invariant about ownership, status, and idle
 * age lives here so routes, the lease layer, and the reaper agree.
 */

export type SandboxOwnerKind = "conversation" | "machine_run";
export type SandboxLeaseStatus = "creating" | "running" | "stopped";

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
  };
  db.insert(sandboxes).values(row).run();
  return hydrate(row);
}

/** The owner's dedicated lease, if one exists (any status). */
export function getLeaseByOwner(
  db: Db,
  ownerKind: SandboxOwnerKind,
  ownerId: string,
): SandboxLease | null {
  const row = db
    .select()
    .from(sandboxes)
    .where(and(eq(sandboxes.ownerKind, ownerKind), eq(sandboxes.ownerId, ownerId)))
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

/** Destroy a lease: delete the row (and any attachments). */
export function deleteLease(db: Db, id: string): void {
  db.delete(sandboxAttachments).where(eq(sandboxAttachments.sandboxId, id)).run();
  db.delete(sandboxes).where(eq(sandboxes.id, id)).run();
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
