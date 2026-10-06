import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { Db } from "./index";
import {
  conversations,
  folders,
  machineRuns,
  previewEvents,
  previews,
  previewSetups,
  projects,
  projectRepos,
  sandboxCalls,
  sandboxAttachments,
  sandboxConfigs,
  sandboxes,
} from "./schema";
import { getPreviewSetup } from "./preview-setups";
import { deleteConversationForever } from "./organize";
import { LIVE_STATUSES } from "./machines";

/**
 * 0018 phase 3: project entity CRUD + the delete cascade's store half.
 * All value-shaped errors; the substrate half (cancel runs, destroy
 * sandboxes) is lib/projects.ts — this file never touches a provider.
 */

export type ProjectResult<T> = ({ ok: true } & T) | { ok: false; code: string; message: string };

const fail = (code: string, message: string) => ({ ok: false as const, code, message });

// ── rename ───────────────────────────────────────────────────────────────

export function renameProject(db: Db, projectId: string, name: string): ProjectResult<{ name: string }> {
  const trimmed = name.trim();
  if (!trimmed) return fail("invalid", "name is required");
  if (trimmed.length > 120) return fail("invalid", "name must be at most 120 characters");
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) return fail("not-found", `no project ${projectId}`);
  db.update(projects).set({ name: trimmed }).where(eq(projects.id, projectId)).run();
  return { ok: true, name: trimmed };
}

// ── repos ────────────────────────────────────────────────────────────────

export function addProjectRepo(
  db: Db,
  projectId: string,
  input: { name: string; url: string },
): ProjectResult<{ repoId: string }> {
  const name = input.name.trim();
  const url = input.url.trim().replace(/\.git$/, "");
  if (!name || !/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    return fail("invalid", "repo name must look like a directory (letters, digits, . _ -)");
  }
  if (!/^https?:\/\//.test(url)) return fail("invalid", "repo url must be http(s)");
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) return fail("not-found", `no project ${projectId}`);
  const clash = db
    .select({ id: projectRepos.id })
    .from(projectRepos)
    .where(and(eq(projectRepos.projectId, projectId), eq(projectRepos.name, name)))
    .get();
  if (clash) return fail("conflict", `a repo named ${name} is already in this project`);
  const id = `${projectId}/${name}`;
  db.insert(projectRepos).values({ id, projectId, name, url, createdAt: Date.now() }).run();
  return { ok: true, repoId: id };
}

/** Removal refuses with named blockers — clearing them is deliberate
 * (0018 phase 3 decision), never a cascade side effect. */
export function removeProjectRepo(db: Db, projectId: string, repoId: string): ProjectResult<{ removed: true }> {
  const repo = db
    .select()
    .from(projectRepos)
    .where(and(eq(projectRepos.id, repoId), eq(projectRepos.projectId, projectId)))
    .get();
  if (!repo) return fail("not-found", `no repo ${repoId} in project ${projectId}`);
  const blockers: string[] = [];
  const setup = getPreviewSetup(db, projectId);
  if (setup.ok && setup.setup?.definition.repo === repoId) {
    blockers.push("the preview setup runs this repo (clear it on the project page first)");
  }
  const referencing = db
    .select({ label: previews.label, slug: previews.slug })
    .from(previews)
    .where(and(eq(previews.repoId, repoId), isNull(previews.deletedAt)))
    .all();
  for (const name of [...new Set(referencing.map((p) => p.label ?? p.slug))]) {
    blockers.push(`preview ${name} follows this repo`);
  }
  if (blockers.length) return fail("conflict", `cannot remove ${repo.name}: ${blockers.join("; ")}`);
  db.delete(projectRepos).where(eq(projectRepos.id, repoId)).run();
  return { ok: true, removed: true };
}

// ── sandbox config ───────────────────────────────────────────────────────

/** How many projects reference a config (the shared-edit note). */
export function getProjectRepo(db: Db, repoId: string) {
  return db.select().from(projectRepos).where(eq(projectRepos.id, repoId)).get() ?? null;
}

export function countProjectsUsingConfig(db: Db, configId: string): number {
  return db.select({ id: projects.id }).from(projects).where(eq(projects.sandboxConfigId, configId)).all().length;
}

export function setProjectSandboxConfig(
  db: Db,
  projectId: string,
  configId: string | null,
): ProjectResult<{ configId: string | null }> {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) return fail("not-found", `no project ${projectId}`);
  if (configId) {
    const config = db.select().from(sandboxConfigs).where(eq(sandboxConfigs.id, configId)).get();
    if (!config) return fail("not-found", `no sandbox config ${configId}`);
  }
  db.update(projects)
    .set({ sandboxConfigId: configId })
    .where(eq(projects.id, projectId))
    .run();
  return { ok: true, configId };
}

/** Edit a config's fields — shared: every project on it changes. */
export function updateSandboxConfig(
  db: Db,
  configId: string,
  fields: { imageRef?: string; networkPolicy?: string },
): ProjectResult<{ sharedWith: number }> {
  const config = db.select().from(sandboxConfigs).where(eq(sandboxConfigs.id, configId)).get();
  if (!config) return fail("not-found", `no sandbox config ${configId}`);
  const set: Partial<{ imageRef: string; networkPolicy: string }> = {};
  if (fields.imageRef !== undefined) {
    const imageRef = fields.imageRef.trim();
    if (!imageRef) return fail("invalid", "image ref cannot be empty — clear the config from projects instead");
    set.imageRef = imageRef;
  }
  if (fields.networkPolicy !== undefined) {
    const policy = fields.networkPolicy.trim();
    if (!/^(allow-all|offline)$/.test(policy)) {
      return fail("invalid", "network policy must be allow-all or offline");
    }
    set.networkPolicy = policy;
  }
  if (Object.keys(set).length) {
    db.update(sandboxConfigs).set(set).where(eq(sandboxConfigs.id, configId)).run();
  }
  return { ok: true, sharedWith: countProjectsUsingConfig(db, configId) };
}

// ── the delete cascade's store half ─────────────────────────────────────

export interface DeleteProjectCounts {
  conversations: number;
  previews: number;
  sandboxes: number;
  folders: number;
  repos: number;
}

/**
 * Delete every row the project owns. The caller (lib/projects.ts) has
 * already cancelled live runs and destroyed live sandbox containers;
 * per-conversation teardown rides `deleteConversationForever` (the
 * purge pattern — own transactions), then one transaction removes the
 * rest. Sandbox ROWS are deleted, a recorded deviation from 0011's
 * rows-stay rule: they exist as call-attribution history, and the
 * calls are deleted here too.
 */
export function deleteProjectRows(db: Db, projectId: string): ProjectResult<{ counts: DeleteProjectCounts }> {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) return fail("not-found", `no project ${projectId}`);

  const conversationIds = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.projectId, projectId))
    .all()
    .map((r) => r.id);
  for (const id of conversationIds) {
    // A run's purge takes its stage visits with it (the visit glob) —
    // skip anything already gone.
    const still = db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, id)).get();
    if (still) deleteConversationForever(db, id);
  }

  const repoIds = db
    .select({ id: projectRepos.id })
    .from(projectRepos)
    .where(eq(projectRepos.projectId, projectId))
    .all()
    .map((r) => r.id);
  const sandboxIds = db
    .select({ id: sandboxes.id })
    .from(sandboxes)
    .where(eq(sandboxes.projectId, projectId))
    .all()
    .map((r) => r.id);

  const counts: DeleteProjectCounts = {
    conversations: conversationIds.length,
    previews: 0,
    sandboxes: sandboxIds.length,
    folders: 0,
    repos: repoIds.length,
  };

  db.transaction((tx) => {
    // Previews: branch rows through their repo, worktree rows through
    // a project sandbox — the same attribution previewProjectId uses.
    const previewIds = (repoIds.length || sandboxIds.length
      ? tx
          .select({ id: previews.id })
          .from(previews)
          .where(
            or(
              ...(repoIds.length ? [inArray(previews.repoId, repoIds)] : []),
              ...(sandboxIds.length ? [inArray(previews.sandboxId, sandboxIds)] : []),
            ),
          )
          .all()
      : []
    ).map((r) => r.id);
    counts.previews = previewIds.length;
    if (previewIds.length) {
      tx.delete(previewEvents).where(inArray(previewEvents.previewId, previewIds)).run();
      tx.delete(previews).where(inArray(previews.id, previewIds)).run();
    }

    if (sandboxIds.length) {
      tx.delete(sandboxCalls).where(inArray(sandboxCalls.sandboxId, sandboxIds)).run();
      tx.delete(sandboxAttachments).where(inArray(sandboxAttachments.sandboxId, sandboxIds)).run();
      tx.delete(sandboxes).where(inArray(sandboxes.id, sandboxIds)).run();
    }

    counts.folders = tx.select({ id: folders.id }).from(folders).where(eq(folders.projectId, projectId)).all().length;
    tx.delete(folders).where(eq(folders.projectId, projectId)).run();
    tx.delete(previewSetups).where(eq(previewSetups.projectId, projectId)).run();
    tx.delete(projectRepos).where(eq(projectRepos.projectId, projectId)).run();
    tx.delete(projects).where(eq(projects.id, projectId)).run();
  });

  return { ok: true, counts };
}

/** The project's live machine-run ids (the orchestrator cancels them). */
export function listLiveProjectRuns(db: Db, projectId: string): string[] {
  return db
    .select({ id: machineRuns.id, status: machineRuns.status })
    .from(machineRuns)
    .where(eq(machineRuns.projectId, projectId))
    .all()
    .filter((r) => LIVE_STATUSES.has(r.status))
    .map((r) => r.id);
}

/** The project's non-destroyed sandbox leases (the orchestrator destroys them). */
export function listLiveProjectSandboxes(db: Db, projectId: string): string[] {
  return db
    .select({ id: sandboxes.id })
    .from(sandboxes)
    .where(and(eq(sandboxes.projectId, projectId), ne(sandboxes.status, "destroyed")))
    .all()
    .map((r) => r.id);
}
