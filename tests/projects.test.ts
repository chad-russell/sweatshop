import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import {
  addProjectRepo,
  deleteProjectRows,
  getProject,
  listProjectCards,
  renameProject,
  removeProjectRepo,
  setProjectImage,
  setProjectWorkSettings,
} from "../db/projects";
import { savePreviewSetup } from "../db/preview-setups";
import { insertPreview } from "../db/previews";
import {
  conversations,
  folders,
  previews as previewsTable,
  previewSetups,
  projects,
  projectRepos,
  sandboxes,
  sandboxServices,
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

describe("0018/0031: project image", () => {
  it("sets and clears the project's sandbox image", () => {
    expect(setProjectImage(db(), "p_crud", "localhost/custom:2")).toMatchObject({
      ok: true,
      imageRef: "localhost/custom:2",
    });
    expect(getProject(db(), "p_crud")?.imageRef).toBe("localhost/custom:2");
    // blank clears to the provider default
    expect(setProjectImage(db(), "p_crud", "  ")).toMatchObject({ ok: true, imageRef: null });
    expect(getProject(db(), "p_crud")?.imageRef).toBeNull();
    expect(setProjectImage(db(), "p_missing", "x")).toMatchObject({ ok: false, code: "not-found" });
  });
});

describe("0023: project work defaults", () => {
  it("sets, partially updates, and clears test command and branch prefix", () => {
    expect(
      setProjectWorkSettings(db(), "p_crud", { testCommand: "npm test", branchPrefix: "eng" }),
    ).toMatchObject({ ok: true, testCommand: "npm test", branchPrefix: "eng" });
    // partial: only the key present is touched
    expect(setProjectWorkSettings(db(), "p_crud", { branchPrefix: null })).toMatchObject({
      ok: true,
      testCommand: "npm test",
      branchPrefix: null,
    });
    expect(getProject(db(), "p_crud")?.testCommand).toBe("npm test");
    expect(getProject(db(), "p_crud")?.branchPrefix).toBeNull();
    // blank clears
    expect(setProjectWorkSettings(db(), "p_crud", { testCommand: " " })).toMatchObject({
      ok: true,
      testCommand: null,
    });
    expect(setProjectWorkSettings(db(), "p_missing", { testCommand: "x" })).toMatchObject({
      ok: false,
      code: "not-found",
    });
  });

  it("rejects bad branch prefixes and overlong test commands", () => {
    // (empty string clears — imageRef semantics, covered above)
    for (const bad of ["feat/x", "two words", "a".repeat(61)]) {
      expect(setProjectWorkSettings(db(), "p_crud", { branchPrefix: bad })).toMatchObject({
        ok: false,
        code: "invalid",
      });
    }
    for (const good of ["eng", "ENG-1234", "cr.2", "a_b-c"]) {
      expect(setProjectWorkSettings(db(), "p_crud", { branchPrefix: good })).toMatchObject({
        ok: true,
        branchPrefix: good,
      });
    }
    expect(setProjectWorkSettings(db(), "p_crud", { testCommand: "x".repeat(501) })).toMatchObject({
      ok: false,
      code: "invalid",
    });
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
      .insert(folders)
      .values({ id: "fld_crud", projectId: "p_del", name: "F", createdAt: now })
      .onConflictDoNothing()
      .run();
    const sandboxId = `sbx_del${Math.floor(Math.random() * 1e6)}`;
    fixtureSandbox(sandboxId, "p_del");
    // 2026-10-08: a sandbox with declared services must not block the
    // cascade's sandbox delete (FK hole found with the spike project).
    db()
      .insert(sandboxServices)
      .values({
        id: `ssvc_${sandboxId}`, sandboxId, name: "db", image: "postgres:16", port: 5432,
        createdAt: now, updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
    const previewId = `pv_del${Math.floor(Math.random() * 1e6)}`;
    fixturePreview(previewId, sandboxId, repoId);
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
      counts: { conversations: 1, repos: 1, folders: 1, sandboxes: 1, previews: 1 },
    });

    // gone: everything project-scoped
    expect(rows("conversations", "project_id", "p_del")).toBe(0);
    expect(rows("folders", "project_id", "p_del")).toBe(0);
    expect(rows("project_repos", "project_id", "p_del")).toBe(0);
    expect(rows("preview_setups", "project_id", "p_del")).toBe(0);
    expect(rows("previews", "id", previewId)).toBe(0);
    expect(rows("preview_events", "preview_id", previewId)).toBe(0);
    expect(rows("sandboxes", "id", sandboxId)).toBe(0);
    expect(rows("projects", "id", "p_del")).toBe(0);

    // untouched: the other project's world
    expect(rows("conversations", "id", "c_other")).toBe(1);
    expect(rows("project_repos", "id", "p_other/keep")).toBe(1);
    expect(rows("projects", "id", "p_other")).toBe(1);

    // idempotent to re-run
    expect(deleteProjectRows(db(), "p_del")).toMatchObject({ ok: false, code: "not-found" });
  });

  it("unbinds surviving conversations whose sandbox the cascade destroys (2026-10-08, round 2)", () => {
    // An attached/plain conversation (project NULL) bound to a
    // project-owned sandbox blocked the sandboxes delete — the binding
    // FK has no cascade. The cascade unbinds instead: the container is
    // gone either way, and a null binding re-chooses on the next send.
    fixtureProject("p_unbind");
    const sandboxId = `sbx_unbind${Math.floor(Math.random() * 1e6)}`;
    fixtureSandbox(sandboxId, "p_unbind");
    fixtureConversation("c_bound_elsewhere", null);
    db()
      .update(conversations)
      .set({ sandboxId, sandboxWorkDir: "/work/x", sandboxOwner: false })
      .where(eq(conversations.id, "c_bound_elsewhere"))
      .run();

    const result = deleteProjectRows(db(), "p_unbind");
    expect(result).toMatchObject({ ok: true, counts: { sandboxes: 1 } });
    const survivor = db().select().from(conversations).where(eq(conversations.id, "c_bound_elsewhere")).get();
    expect(survivor).toMatchObject({ sandboxId: null, sandboxWorkDir: null, sandboxOwner: null });
  });
});

// ── tiny helper over raw counts ──────────────────────────────────────────

function rows(table: string, column: string, value: string): number {
  const row = db().$client.prepare(`select count(*) as n from ${table} where ${column} = ?`).get(value) as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

describe("listProjectCards (0040)", () => {
  it("counts repos and live chats per project, by name, and rolls up needs-you", () => {
    fixtureProject("card-b");
    fixtureProject("card-a");
    fixtureRepo("card-a", "one");
    fixtureRepo("card-a", "two");
    fixtureConversation("card_live_1", "card-a");
    fixtureConversation("card_live_2", "card-a");
    fixtureConversation("card_stage", "card-a", "stage");
    fixtureConversation("card_archived", "card-a");
    fixtureConversation("card_trashed", "card-a");
    fixtureConversation("card_unbound", null);
    db().update(conversations).set({ archivedAt: now }).where(eq(conversations.id, "card_archived")).run();
    db().update(conversations).set({ trashedAt: now }).where(eq(conversations.id, "card_trashed")).run();

    const cards = listProjectCards(db(), new Set(["card_live_2", "card_unbound"]));
    const a = cards.find((c) => c.id === "card-a");
    const b = cards.find((c) => c.id === "card-b");

    expect(a).toEqual({ id: "card-a", name: "card-a", repoCount: 2, chatCount: 2, needsYou: 1 });
    expect(b).toEqual({ id: "card-b", name: "card-b", repoCount: 0, chatCount: 0, needsYou: 0 });
    // Sorted by name.
    expect(cards.findIndex((c) => c.id === "card-a")).toBeLessThan(cards.findIndex((c) => c.id === "card-b"));
  });
});
