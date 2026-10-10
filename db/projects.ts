import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { Db } from "./index";
import {
  conversations,
  folders,
  gitCredentials,
  machineRuns,
  previewEvents,
  previews,
  previewSetups,
  projects,
  projectRepos,
  sandboxAttachments,
  sandboxServices,
  sandboxes,
} from "./schema";
import { getPreviewSetup } from "./preview-setups";
import { deleteConversationForever } from "./organize";

/**
 * 0018 phase 3: project entity CRUD + the delete cascade's store half.
 * All value-shaped errors; the substrate half (destroy sandboxes) is
 * lib/projects.ts — this file never touches a provider.
 */

export type ProjectResult<T> = ({ ok: true } & T) | { ok: false; code: string; message: string };

const fail = (code: string, message: string) => ({ ok: false as const, code, message });

// ── create (0033 Phase B — the agent tool is the first creation path;
// no UI form exists) ──────────────────────────────────────────────────

/** Everything `createProject` validates, without inserting — the
 * approval preview runs this, the approved call inserts. */
export function checkNewProject(
  db: Db,
  input: { id: string; name: string; repos?: { name: string; url: string }[] },
): { ok: true; id: string; repos: string[] } | { ok: false; code: string; message: string } {
  const id = input.id.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) {
    return fail("invalid", "project id is lowercase kebab-case-ish (letters, digits, -), 40 chars max");
  }
  if (!input.name?.trim()) return fail("invalid", "name is required");
  if (input.name.trim().length > 120) return fail("invalid", "name must be at most 120 characters");
  if (db.select().from(projects).where(eq(projects.id, id)).get()) {
    return fail("conflict", `project ${id} already exists`);
  }
  const seen: string[] = [];
  for (const r of input.repos ?? []) {
    const name = r.name.trim();
    const url = r.url.trim().replace(/\.git$/, "");
    if (!name || !/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
      return fail("invalid", `repo name "${r.name}" must look like a directory (letters, digits, . _ -)`);
    }
    if (!/^https?:\/\//.test(url)) return fail("invalid", `repo url "${r.url}" must be http(s)`);
    if (seen.includes(name)) return fail("invalid", `repo name ${name} given twice`);
    seen.push(name);
  }
  return { ok: true, id, repos: seen };
}

/** Create a project with its repos, atomically. */
export function createProject(
  db: Db,
  input: { id: string; name: string; description?: string | null; repos?: { name: string; url: string }[] },
): ProjectResult<{ project: { id: string; name: string }; repos: string[] }> {
  const checked = checkNewProject(db, input);
  if (!checked.ok) return checked;
  const name = input.name.trim();
  const now = Date.now();
  db.transaction((tx) => {
    tx.insert(projects)
      .values({ id: checked.id, name, description: input.description?.trim() || null, createdAt: now })
      .run();
    for (const r of input.repos ?? []) {
      tx.insert(projectRepos)
        .values({
          id: `${checked.id}/${r.name.trim()}`,
          projectId: checked.id,
          name: r.name.trim(),
          url: r.url.trim().replace(/\.git$/, ""),
          createdAt: now,
        })
        .run();
    }
  });
  return { ok: true, project: { id: checked.id, name }, repos: checked.repos };
}

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
export function getProject(db: Db, projectId: string) {
  return db.select().from(projects).where(eq(projects.id, projectId)).get() ?? null;
}

export function listProjectRepos(db: Db, projectId: string) {
  return db.select().from(projectRepos).where(eq(projectRepos.projectId, projectId)).all();
}

export function listGitCredentials(db: Db) {
  return db.select().from(gitCredentials).all();
}

/** Projects with at least one repo — the ones a preview can target. */
export function listProjectsWithRepos(db: Db): { id: string; name: string }[] {
  const withRepos = new Set(db.select({ p: projectRepos.projectId }).from(projectRepos).all().map((r) => r.p));
  return db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .all()
    .filter((p) => withRepos.has(p.id));
}

/** Everything the project page renders, in one read. */
export function getProjectOverview(db: Db, projectId: string) {
  const project = getProject(db, projectId);
  if (!project) return null;
  return {
    project,
    repos: listProjectRepos(db, projectId),
    credentials: listGitCredentials(db),
    setup: getPreviewSetup(db, projectId),
  };
}

export function getProjectRepo(db: Db, repoId: string) {
  return db.select().from(projectRepos).where(eq(projectRepos.id, repoId)).get() ?? null;
}

/** 0031: set (or clear, with null/empty) the project's sandbox image. */
export function setProjectImage(
  db: Db,
  projectId: string,
  imageRef: string | null,
): ProjectResult<{ imageRef: string | null }> {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) return fail("not-found", `no project ${projectId}`);
  const next = imageRef?.trim() ? imageRef.trim() : null;
  db.update(projects).set({ imageRef: next }).where(eq(projects.id, projectId)).run();
  return { ok: true, imageRef: next };
}

/** 0023: set (or clear, with null/empty) the project's work defaults —
 * the verify-stage test command and the machine branch prefix, both
 * carried in stage briefs ("# Project"). Partial: only the keys
 * present are touched. */
export function setProjectWorkSettings(
  db: Db,
  projectId: string,
  input: { testCommand?: string | null; branchPrefix?: string | null },
): ProjectResult<{ testCommand: string | null; branchPrefix: string | null }> {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) return fail("not-found", `no project ${projectId}`);
  const patch: { testCommand?: string | null; branchPrefix?: string | null } = {};
  if (input.testCommand !== undefined) {
    const next = (input.testCommand ?? "").trim();
    if (next.length > 500) return fail("invalid", "test command is over 500 characters");
    patch.testCommand = next || null;
  }
  if (input.branchPrefix !== undefined) {
    const next = (input.branchPrefix ?? "").trim();
    if (next && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/.test(next)) {
      return fail("invalid", "branch prefix is one path segment (letters, digits, . _ -), 60 chars max");
    }
    patch.branchPrefix = next || null;
  }
  if (Object.keys(patch).length > 0) {
    db.update(projects).set(patch).where(eq(projects.id, projectId)).run();
  }
  return {
    ok: true,
    testCommand: patch.testCommand !== undefined ? patch.testCommand : (project.testCommand ?? null),
    branchPrefix: patch.branchPrefix !== undefined ? patch.branchPrefix : (project.branchPrefix ?? null),
  };
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
      // Surviving conversations (or runs) bound to a sandbox this
      // cascade destroys lose the binding — the container is gone
      // either way, and a null binding re-chooses on the next send
      // (found live 2026-10-08: an attached e2e chat with a NULL
      // project blocked the whole delete; SQL `!=` hides NULLs, so
      // those rows were invisible to every earlier probe).
      tx.update(conversations)
        .set({ sandboxId: null, sandboxWorkDir: null, sandboxOwner: null })
        .where(inArray(conversations.sandboxId, sandboxIds))
        .run();
      tx.update(machineRuns)
        .set({ sandboxId: null, sandboxWorkDir: null, sandboxOwner: null })
        .where(inArray(machineRuns.sandboxId, sandboxIds))
        .run();
      tx.delete(sandboxAttachments).where(inArray(sandboxAttachments.sandboxId, sandboxIds)).run();
      // 0017 services FK the sandbox — they die with it (same class as
      // the conversation-teardown FK hole, found 2026-10-08).
      tx.delete(sandboxServices).where(inArray(sandboxServices.sandboxId, sandboxIds)).run();
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

/** The project's non-destroyed sandbox leases (the orchestrator destroys them). */
export function listLiveProjectSandboxes(db: Db, projectId: string): string[] {
  return db
    .select({ id: sandboxes.id })
    .from(sandboxes)
    .where(and(eq(sandboxes.projectId, projectId), ne(sandboxes.status, "destroyed")))
    .all()
    .map((r) => r.id);
}
