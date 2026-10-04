import { and, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "./index";
import { previews, sandboxes, type PreviewRow } from "./schema";

/**
 * 0016 preview registry. Every invariant about a preview row — slug
 * shape and uniqueness, status vocabulary, "live" vs history — lives
 * here so the tools, the tick, the proxy, and the routes agree. Rows
 * are never deleted: `deleted_at` hides them (the slug becomes reusable)
 * while history stays.
 */

export type PreviewStatus = "starting" | "healthy" | "crashed" | "stopped" | "failed";
export type PreviewSource = "worktree" | "branch";

export type Preview = Omit<PreviewRow, "status" | "source"> & {
  status: PreviewStatus;
  source: PreviewSource;
};

/** Statuses with a process that should be up (the tick watches these). */
export const RUNNING_PREVIEW_STATUSES: readonly PreviewStatus[] = ["starting", "healthy"];

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
}

export function insertPreview(db: Db, input: NewPreview): Preview {
  const now = Date.now();
  const row: PreviewRow = {
    id: `pv_${nanoid()}`,
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
    status: "starting",
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

/** Previews the tick reconciles: not deleted, and not settled as stopped. */
export function listWatchedPreviews(db: Db): Preview[] {
  return db
    .select()
    .from(previews)
    .where(and(isNull(previews.deletedAt), notInArray(previews.status, ["stopped"])))
    .all()
    .map(hydrate);
}

export function updatePreview(
  db: Db,
  id: string,
  set: Partial<Pick<Preview, "status" | "error" | "headSha" | "command" | "port" | "label">>,
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
