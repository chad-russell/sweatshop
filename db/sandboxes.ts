import { and, asc, desc, eq, lt, ne, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "./index";
import { conversations, sandboxAttachments, sandboxCalls, sandboxes } from "./schema";

/**
 * 0010 Phase 2 sandbox lease store. The `sandboxes` table is a registry
 * of leases (0011: destroyed rows stay as history so recorded calls keep
 * a target); every invariant about ownership, status, and idle age lives
 * here so routes, the lease layer, and the reaper agree. 0013 adds the
 * conversation's sandbox binding (columns on `conversations`).
 */

/** 0016 adds "preview": a branch preview's dedicated sandbox. */
export type SandboxOwnerKind = "conversation" | "machine_run" | "preview";
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
  /** 0017: set when destroyed; the row stays as history. */
  destroyedAt: number | null;
  /** 0017: when the setup's `provision` ran against this sandbox. */
  servicesProvisionedAt: number | null;
  /** 0017 amendment: when the setup's `seed` ran (independent of
   *  provision — an already-provisioned sandbox still seeds). */
  seededAt: number | null;
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
    servicesProvisionedAt: row.servicesProvisionedAt ?? null,
    seededAt: row.seededAt ?? null,
  };
}

/** 0017: stamp the once-per-sandbox `provision` as done. */
export function markServicesProvisioned(db: Db, sandboxId: string): void {
  db.update(sandboxes)
    .set({ servicesProvisionedAt: Date.now() })
    .where(eq(sandboxes.id, sandboxId))
    .run();
}

/** 0017 amendment: stamp the once-per-sandbox `seed` as done. */
export function markSeeded(db: Db, sandboxId: string): void {
  db.update(sandboxes)
    .set({ seededAt: Date.now() })
    .where(eq(sandboxes.id, sandboxId))
    .run();
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
    servicesProvisionedAt: null,
    seededAt: null,
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

// ── 0013: conversation sandbox bindings ─────────────────────────────────

/**
 * Which sandbox a top-level chat or run (and everything below it) runs
 * in — chosen once. Plain data: it crosses workflow step boundaries
 * as-is (lib/sandboxes/binding.ts turns it into a live handle).
 *
 *   none:    no sandboxed tools (plain chat, or "no sandbox" chosen)
 *   pending: a project chat whose own sandbox is created on first use
 *   bound:   fixed for good; `owner` = controls lifecycle, false =
 *            attached/inherited (never stops or destroys it)
 */
export type SandboxBinding =
  /** `disabled`: "no sandbox" was chosen (vs. a plain chat, unbound). */
  | { kind: "none"; disabled?: true }
  | { kind: "pending"; projectId: string }
  | { kind: "bound"; sandboxId: string; workDir: string; owner: boolean };

export type BoundSandbox = Extract<SandboxBinding, { kind: "bound" }>;

/** The conversation's binding; null when the conversation is absent. */
export function getConversationBinding(db: Db, conversationId: string): SandboxBinding | null {
  const row = db
    .select({
      projectId: conversations.projectId,
      sandboxId: conversations.sandboxId,
      workDir: conversations.sandboxWorkDir,
      owner: conversations.sandboxOwner,
      disabled: conversations.sandboxDisabled,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  if (!row) return null;
  if (row.sandboxId && row.workDir) {
    return { kind: "bound", sandboxId: row.sandboxId, workDir: row.workDir, owner: !!row.owner };
  }
  if (row.disabled) return { kind: "none", disabled: true };
  return row.projectId ? { kind: "pending", projectId: row.projectId } : { kind: "none" };
}

/**
 * Bind an unbound conversation — exactly once. Returns the binding that
 * holds afterwards: `binding` when this call bound it, otherwise the one
 * an earlier call already set (a binding never changes).
 */
export function bindConversation(
  db: Db,
  conversationId: string,
  binding: BoundSandbox,
): BoundSandbox {
  db.update(conversations)
    .set({
      sandboxId: binding.sandboxId,
      sandboxWorkDir: binding.workDir,
      sandboxOwner: binding.owner,
    })
    .where(and(eq(conversations.id, conversationId), sql`${conversations.sandboxId} is null`))
    .run();
  const now = getConversationBinding(db, conversationId);
  if (now?.kind !== "bound") throw new Error(`could not bind conversation ${conversationId}`);
  return now;
}

/** Choose "no sandbox" for a not-yet-bound conversation (creation only). */
export function disableConversationSandbox(db: Db, conversationId: string): void {
  db.update(conversations)
    .set({ sandboxDisabled: true })
    .where(and(eq(conversations.id, conversationId), sql`${conversations.sandboxId} is null`))
    .run();
}
