import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import {
  addProjectRepo,
  deleteProjectRows,
  renameProject,
  removeProjectRepo,
  setProjectSandboxConfig,
  updateSandboxConfig,
} from "../db/projects";
import { savePreviewSetup } from "../db/preview-setups";
import { insertPreview } from "../db/previews";
import {
  conversations,
  folders,
  machineRuns,
  previews as previewsTable,
  previewSetups,
  projects,
  projectRepos,
  sandboxConfigs,
  sandboxes,
} from "../db/schema";

/**
 * 0018 phase 3: project CRUD + the delete cascade's store half. The
 * substrate half (cancel runs, destroy sandboxes) is route-level; the
 * rows are what these tests pin.
 */

const now = Date.now();

function fixtureProject(id: string) {
  db().insert(projects).values({ id, name: id, createdAt: now }).onConflictDoNothing().run();
}

function fixtureRepo(projectId: string, name: string, url = `https://git.example/${name}.git`) {
  const id = `${projectId}/${name}`;
  db()
    .insert(projectRepos)
    .values({ id, projectId, name, url, createdAt: now })
    .onConflictDoNothing()
    .run();
  return id;
}

function fixtureConversation(id: string, projectId: string | null, kind: "chat" | "run" | "stage" = "chat") {
  db()
    .insert(conversations)
    .values({ id, projectId, kind, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run();
}

function fixtureSandbox(id: string, projectId: string | null) {
  db()
    .$client.prepare(
      "insert into sandboxes (id, provider, ref, owner_kind, owner_id, project_id, status, last_used_at, created_at) " +
        "values (?, 'podman', ?, 'conversation', ?, ?, 'stopped', ?, ?)",
    )
    .run(id, `ref-${id}`, id, projectId, now, now);
}

function fixturePreview(id: string, sandboxId: string, repoId: string | null) {
  insertPreview(db(), {
    id,
    sandboxId,
    workDir: `/work/${id}`,
    command: "pnpm run dev",
    port: 3000,
    label: id,
    source: "branch",
    ...(repoId ? { repoId } : {}),
    branch: "main",
    startedBy: "user",
  });
}

beforeEach(() => {
  fixtureProject("p_crud");
  fixtureProject("p_other");
});

describe("0018 phase 3: rename + repos", () => {
  it("renames, and refuses empty names and unknown projects", () => {
    expect(renameProject(db(), "p_crud", "Renamed")).toMatchObject({ ok: true, name: "Renamed" });
    expect(renameProject(db(), "p_crud", "  ")).toMatchObject({ ok: false, code: "invalid" });
    expect(renameProject(db(), "p_missing", "X")).toMatchObject({ ok: false, code: "not-found" });
  });

  it("adds repos with per-project unique names, validating shape", () => {
    const added = addProjectRepo(db(), "p_crud", { name: "web", url: "https://github.com/org/web.git" });
    expect(added).toMatchObject({ ok: true, repoId: "p_crud/web" });
    expect(addProjectRepo(db(), "p_crud", { name: "web", url: "https://x/y" })).toMatchObject({
      ok: false,
      code: "conflict",
    });
    // the same name is fine in another project
    expect(addProjectRepo(db(), "p_other", { name: "web", url: "https://x/y" })).toMatchObject({ ok: true });
    expect(addProjectRepo(db(), "p_crud", { name: "bad name!", url: "https://x/y" })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(addProjectRepo(db(), "p_crud", { name: "ok", url: "git@git.example:x/y" })).toMatchObject({
      ok: false,
      code: "invalid",
    });
  });

  it("repo removal refuses with named blockers, then removes when clear", () => {
    const repoId = fixtureRepo("p_crud", "web");
    const sandboxId = `sbx_guard${Math.floor(Math.random() * 1e6)}`;
    fixtureSandbox(sandboxId, "p_crud");
    fixturePreview(`pv_guard${Math.floor(Math.random() * 1e6)}`, sandboxId, repoId);
    savePreviewSetup(db(), "p_crud", {
      repo: repoId,
      workDir: ".",
      install: "pnpm install",
      command: "pnpm run dev",
      port: 3000,
      env: {},
      services: [],
    });

    const blocked = removeProjectRepo(db(), "p_crud", repoId);
    expect(blocked).toMatchObject({ ok: false, code: "conflict" });
    if (!blocked.ok) {
      expect(blocked.message).toContain("preview setup");
      expect(blocked.message).toContain("preview");
    }

    // clear the blockers: drop the setup and the preview
    db().delete(previewSetups).where(eq(previewSetups.projectId, "p_crud")).run();
    db().delete(previewsTable).where(eq(previewsTable.repoId, repoId)).run();
    expect(removeProjectRepo(db(), "p_crud", repoId)).toMatchObject({ ok: true });
  });
});

describe("0018 phase 3: sandbox config", () => {
  it("picks none/existing and edits fields with a shared count", () => {
    db()
      .insert(sandboxConfigs)
      .values({ id: "cfg_a", name: "default", imageRef: null, networkPolicy: "allow-all", createdAt: now })
      .onConflictDoNothing()
      .run();
    expect(setProjectSandboxConfig(db(), "p_crud", "cfg_a")).toMatchObject({ ok: true, configId: "cfg_a" });
    expect(setProjectSandboxConfig(db(), "p_other", "cfg_a")).toMatchObject({ ok: true });
    expect(updateSandboxConfig(db(), "cfg_a", { imageRef: "localhost/custom", networkPolicy: "offline" })).toMatchObject({
      ok: true,
      sharedWith: 2,
    });
    expect(updateSandboxConfig(db(), "cfg_a", { networkPolicy: "nonsense" })).toMatchObject({ ok: false, code: "invalid" });
    expect(updateSandboxConfig(db(), "cfg_missing", { networkPolicy: "offline" })).toMatchObject({
      ok: false,
      code: "not-found",
    });
    expect(setProjectSandboxConfig(db(), "p_crud", null)).toMatchObject({ ok: true, configId: null });
  });
});

describe("0018 phase 3: the delete cascade", () => {
  it("deletes everything the project owns and nothing else", () => {
    fixtureProject("p_del");
    const repoId = fixtureRepo("p_del", "web");
    fixtureRepo("p_other", "keep"); // must survive
    fixtureConversation("c_crud_chat", "p_del");
    fixtureConversation("c_other", "p_other"); // must survive
    db()
      .insert(machineRuns)
      .values({
        id: "mr_crud_run",
        machineName: "m",
        machineVersion: 1,
        definition: "{}",
        projectId: "p_del",
        prompt: "x",
        status: "completed",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
    fixtureConversation("mr_crud_run", "p_del", "run");
    fixtureConversation("mr_crud_run_1", "p_del", "stage");
    db()
      .insert(folders)
      .values({ id: "fld_crud", projectId: "p_del", name: "F", createdAt: now })
      .onConflictDoNothing()
      .run();
    const sandboxId = `sbx_del${Math.floor(Math.random() * 1e6)}`;
    fixtureSandbox(sandboxId, "p_del");
    const previewId = `pv_del${Math.floor(Math.random() * 1e6)}`;
    fixturePreview(previewId, sandboxId, repoId);
    db()
      .$client.prepare(
        "insert into sandbox_calls (tool_call_id, sandbox_id, conversation_id, tool, via, workdir, at) " +
          "values (?, ?, 'c_crud_chat', 'bash', 'dedicated', '/w', ?)",
      )
      .run(`tc_del${Math.floor(Math.random() * 1e6)}`, sandboxId, now);
    savePreviewSetup(db(), "p_del", {
      repo: repoId,
      workDir: ".",
      install: "pnpm install",
      command: "pnpm run dev",
      port: 3000,
      env: {},
      services: [],
    });

    const result = deleteProjectRows(db(), "p_del");
    expect(result).toMatchObject({
      ok: true,
      counts: { conversations: 3, repos: 1, folders: 1, sandboxes: 1, previews: 1 },
    });

    // gone: everything project-scoped
    expect(rows("conversations", "project_id", "p_del")).toBe(0);
    expect(rows("conversations", "id", "mr_crud_run")).toBe(0);
    expect(rows("machine_runs", "project_id", "p_del")).toBe(0);
    expect(rows("folders", "project_id", "p_del")).toBe(0);
    expect(rows("project_repos", "project_id", "p_del")).toBe(0);
    expect(rows("preview_setups", "project_id", "p_del")).toBe(0);
    expect(rows("previews", "id", previewId)).toBe(0);
    expect(rows("preview_events", "preview_id", previewId)).toBe(0);
    expect(rows("sandboxes", "id", sandboxId)).toBe(0);
    expect(rows("sandbox_calls", "sandbox_id", sandboxId)).toBe(0);
    expect(rows("projects", "id", "p_del")).toBe(0);

    // untouched: the other project's world
    expect(rows("conversations", "id", "c_other")).toBe(1);
    expect(rows("project_repos", "id", "p_other/keep")).toBe(1);
    expect(rows("projects", "id", "p_other")).toBe(1);

    // idempotent to re-run
    expect(deleteProjectRows(db(), "p_del")).toMatchObject({ ok: false, code: "not-found" });
  });
});

// ── tiny helper over raw counts ──────────────────────────────────────────

function rows(table: string, column: string, value: string): number {
  const row = db().$client.prepare(`select count(*) as n from ${table} where ${column} = ?`).get(value) as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}
