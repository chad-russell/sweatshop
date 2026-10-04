import { and, desc, eq, inArray, isNull, lt, notInArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "./index";
import { previewEvents, previews, sandboxes, type PreviewRow } from "./schema";

/**
 * 0016 preview registry. Every invariant about a preview row — slug
 * shape and uniqueness, status vocabulary, "live" vs history — lives
 * here so the tools, the tick, the proxy, and the routes agree. Rows
 * are never deleted: `deleted_at` hides them (the slug becomes reusable)
 * while history stays.
 */

export type PreviewStatus =
  | "provisioning"
  | "starting"
  | "healthy"
  | "crashed"
  | "stopped"
  | "failed";
export type PreviewSource = "worktree" | "branch";

export type Preview = Omit<PreviewRow, "status" | "source"> & {
  status: PreviewStatus;
  source: PreviewSource;
};

/** Statuses with a process that should be up (the tick watches these). */
export const RUNNING_PREVIEW_STATUSES: readonly PreviewStatus[] = [
  "provisioning",
  "starting",
  "healthy",
];

/** 0017: a provisioning row older than this never got confirmed — the
 *  tick parks it failed so an abandoned create is visible, not stuck. */
export const PROVISIONING_STALE_MS = 30 * 60_000;

const ERROR_LIMIT = 2_000;

function hydrate(row: PreviewRow): Preview {
  return row as Preview;
}

/** Clip a failure reason to what a row (and a card) can carry. */
export function clipError(text: string): string {
  return text.length <= ERROR_LIMIT ? text : `…${text.slice(-(ERROR_LIMIT - 1))}`;
}

/**
 * A DNS-safe slug: the label lowercased to [a-z0-9-], plus four random
 * chars so two previews of `main` never collide. The URL label is
 * `pv-<slug>`, which must fit in 63 chars.
 */
export function makeSlug(label: string | null | undefined): string {
  const base = (label ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  const rand = nanoid(8).toLowerCase().replace(/[^a-z0-9]/g, "").padEnd(4, "0").slice(0, 4);
  return base ? `${base}-${rand}` : rand;
}

export interface NewPreview {
  sandboxId: string;
  workDir: string;
  command: string;
  port: number;
  label?: string | null;
  source: PreviewSource;
  repoId?: string | null;
  branch?: string | null;
  startedBy: string;
  /** Override the generated slug (tests). */
  slug?: string;
  /** Pre-minted id (a branch preview names its sandbox owner by it). */
  id?: string;
  /** 0017: branch previews insert as `provisioning` (default starting). */
  status?: PreviewStatus;
}

export function newPreviewId(): string {
  return `pv_${nanoid()}`;
}

export function insertPreview(db: Db, input: NewPreview): Preview {
  const now = Date.now();
  const row: PreviewRow = {
    id: input.id ?? newPreviewId(),
    slug: input.slug ?? makeSlug(input.label ?? input.branch),
    sandboxId: input.sandboxId,
    workDir: input.workDir,
    command: input.command,
    port: input.port,
    label: input.label ?? null,
    source: input.source,
    repoId: input.repoId ?? null,
    branch: input.branch ?? null,
    headSha: null,
    failedSha: null,
    dismissedSha: null,
    status: input.status ?? "starting",
    startedBy: input.startedBy,
    lastRequestAt: null,
    error: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(previews).values(row).run();
  return hydrate(row);
}

export function getPreview(db: Db, id: string): Preview | null {
  const row = db.select().from(previews).where(eq(previews.id, id)).get();
  return row ? hydrate(row) : null;
}

/** The live (not deleted) preview answering on a slug — the proxy's lookup. */
export function getPreviewBySlug(db: Db, slug: string): Preview | null {
  const row = db
    .select()
    .from(previews)
    .where(and(eq(previews.slug, slug), isNull(previews.deletedAt)))
    .get();
  return row ? hydrate(row) : null;
}

/**
 * The not-deleted preview for (sandbox, directory, port) — start_preview
 * is idempotent on this triple (a second call restarts, never duplicates).
 */
export function findPreview(db: Db, sandboxId: string, workDir: string, port: number): Preview | null {
  const row = db
    .select()
    .from(previews)
    .where(
      and(
        eq(previews.sandboxId, sandboxId),
        eq(previews.workDir, workDir),
        eq(previews.port, port),
        isNull(previews.deletedAt),
      ),
    )
    .get();
  return row ? hydrate(row) : null;
}

/** Not-deleted previews in the given sandboxes, newest first. */
export function listPreviewsForSandboxes(db: Db, sandboxIds: string[]): Preview[] {
  if (sandboxIds.length === 0) return [];
  return db
    .select()
    .from(previews)
    .where(and(inArray(previews.sandboxId, sandboxIds), isNull(previews.deletedAt)))
    .orderBy(desc(previews.createdAt))
    .all()
    .map(hydrate);
}

/** Every not-deleted preview, newest first (the /previews list). */
export function listPreviews(db: Db): Preview[] {
  return db
    .select()
    .from(previews)
    .where(isNull(previews.deletedAt))
    .orderBy(desc(previews.createdAt))
    .all()
    .map(hydrate);
}

/** Previews the tick reconciles: not deleted, not settled as stopped,
 *  and not still provisioning (the driving request owns those). */
export function listWatchedPreviews(db: Db): Preview[] {
  return db
    .select()
    .from(previews)
    .where(and(isNull(previews.deletedAt), notInArray(previews.status, ["stopped", "provisioning"])))
    .all()
    .map(hydrate);
}

/** 0017: park provisioning rows that never got confirmed (abandoned
 *  creates). Returns the ids that aged out. */
export function expireStaleProvisioning(db: Db, now: number = Date.now()): string[] {
  const stale = db
    .select({ id: previews.id })
    .from(previews)
    .where(
      and(
        eq(previews.status, "provisioning"),
        isNull(previews.deletedAt),
        lt(previews.updatedAt, now - PROVISIONING_STALE_MS),
      ),
    )
    .all();
  for (const row of stale) {
    updatePreview(db, row.id, {
      status: "failed",
      error: "provisioning never completed (no confirm within 30 min)",
      failedSha: "create",
    });
  }
  return stale.map((r) => r.id);
}

export function updatePreview(
  db: Db,
  id: string,
  set: Partial<
    Pick<
      Preview,
      "status" | "error" | "headSha" | "failedSha" | "dismissedSha" | "command" | "port" | "label" | "workDir"
    >
  >,
): void {
  const next = { ...set, updatedAt: Date.now() };
  if (next.error) next.error = clipError(next.error);
  db.update(previews).set(next).where(eq(previews.id, id)).run();
}

/** Proxy traffic stamp (the idle signal). */
export function stampRequest(db: Db, id: string, at: number = Date.now()): void {
  db.update(previews).set({ lastRequestAt: at }).where(eq(previews.id, id)).run();
}

/** Hide a preview (its slug becomes reusable); the row stays as history. */
export function markPreviewDeleted(db: Db, id: string): void {
  const now = Date.now();
  db.update(previews)
    .set({ deletedAt: now, status: "stopped", updatedAt: now })
    .where(eq(previews.id, id))
    .run();
}

/** A sandbox stopped or destroyed: its previews' processes are gone. */
export function markSandboxPreviewsStopped(db: Db, sandboxId: string): void {
  db.update(previews)
    .set({ status: "stopped", updatedAt: Date.now() })
    .where(
      and(
        eq(previews.sandboxId, sandboxId),
        isNull(previews.deletedAt),
        inArray(previews.status, ["starting", "healthy", "crashed"]),
      ),
    )
    .run();
}

/** The preview's last activity: its last proxied request, else its last change. */
export function previewActivityAt(p: Pick<Preview, "lastRequestAt" | "updatedAt">): number {
  return Math.max(p.lastRequestAt ?? 0, p.updatedAt);
}

/** The sandbox's provider ref + status (what the proxy and tick need). */
export function previewSandbox(
  db: Db,
  sandboxId: string,
): { ref: string; status: string } | null {
  return (
    db
      .select({ ref: sandboxes.ref, status: sandboxes.status })
      .from(sandboxes)
      .where(eq(sandboxes.id, sandboxId))
      .get() ?? null
  );
}

// ── 0016 phase 3: branch previews ───────────────────────────────────────

/** Not-deleted branch previews (the follower's input). */
export function listBranchPreviews(db: Db): Preview[] {
  return db
    .select()
    .from(previews)
    .where(and(isNull(previews.deletedAt), eq(previews.source, "branch")))
    .all()
    .map(hydrate);
}

/** Failed branch previews Chad has not dismissed at this sha (Inbox items). */
export function listFailedPreviews(db: Db): Preview[] {
  return listBranchPreviews(db).filter(
    (p) => p.status === "failed" && p.failedSha !== null && p.failedSha !== p.dismissedSha,
  );
}

export type PreviewEventResult = "deployed" | "reloaded" | "failed" | "reset";

export interface PreviewEvent {
  id: number;
  previewId: string;
  sha: string;
  result: PreviewEventResult;
  detail: string | null;
  at: number;
}

const EVENTS_KEPT = 20;

/** Record one follow outcome; keeps the last EVENTS_KEPT per preview. */
export function recordPreviewEvent(
  db: Db,
  input: { previewId: string; sha: string; result: PreviewEventResult; detail?: string | null },
): void {
  db.insert(previewEvents)
    .values({
      previewId: input.previewId,
      sha: input.sha,
      result: input.result,
      detail: input.detail ? clipError(input.detail) : null,
      at: Date.now(),
    })
    .run();
  const keep = db
    .select({ id: previewEvents.id })
    .from(previewEvents)
    .where(eq(previewEvents.previewId, input.previewId))
    .orderBy(desc(previewEvents.id))
    .limit(EVENTS_KEPT)
    .all()
    .map((r) => r.id);
  if (keep.length === EVENTS_KEPT) {
    db.delete(previewEvents)
      .where(and(eq(previewEvents.previewId, input.previewId), notInArray(previewEvents.id, keep)))
      .run();
  }
}

export function listPreviewEvents(db: Db, previewId: string): PreviewEvent[] {
  return db
    .select()
    .from(previewEvents)
    .where(eq(previewEvents.previewId, previewId))
    .orderBy(desc(previewEvents.id))
    .all() as PreviewEvent[];
}
