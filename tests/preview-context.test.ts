import { describe, expect, it } from "vitest";
import { db } from "../db";
import { getProjectOverview, listProjectsWithRepos } from "../db/projects";
import { getLeaseProjectId } from "../db/sandboxes";
import { savePreviewSetup } from "../db/preview-setups";
import { insertPreview } from "../db/previews";
import { conversations, machineRuns, projectRepos, projects, sandboxConfigs } from "../db/schema";
import { previewProjectId, resolvePreviewContext } from "../lib/previews/context";

/**
 * 0019 phase 1: the one resolver (a preview's project, setup and repo
 * root) and the db/ reads the pages and routes moved onto.
 */

const now = Date.now();

function project(id: string, withRepo: boolean, configId?: string) {
  db().insert(projects).values({ id, name: id, ...(configId ? { sandboxConfigId: configId } : {}), createdAt: now }).run();
  if (!withRepo) return null;
  const repoId = `${id}/web`;
  db().insert(projectRepos).values({ id: repoId, projectId: id, name: "web", url: "https://git.example/web.git", createdAt: now }).run();
  return repoId;
}

function lease(id: string, ownerKind: string, ownerId: string, projectId: string | null) {
  db()
    .$client.prepare(
      "insert into sandboxes (id, provider, ref, owner_kind, owner_id, project_id, status, last_used_at, created_at) " +
        "values (?, 'podman', ?, ?, ?, ?, 'running', ?, ?)",
    )
    .run(id, `ref-${id}`, ownerKind, ownerId, projectId, now, now);
}

function preview(id: string, sandboxId: string, repoId?: string) {
  insertPreview(db(), {
    id,
    sandboxId,
    workDir: `/work/${id}`,
    command: "pnpm run dev",
    port: 3000,
    label: id,
    source: repoId ? "branch" : "worktree",
    ...(repoId ? { repoId, branch: "main" } : {}),
    startedBy: "user",
    status: "healthy",
  });
}

const setupFor = (repo: string) => ({
  repo,
  workDir: ".",
  install: "pnpm install",
  command: "pnpm run dev",
  port: 3000,
  env: { A: "1" },
  services: [],
});

describe("0019: resolvePreviewContext", () => {
  it("a branch preview resolves through its repo; repoRoot is under the lease owner's work root", () => {
    const repoId = project("p_ctx_branch", true)!;
    savePreviewSetup(db(), "p_ctx_branch", setupFor(repoId));
    lease("sbx_ctx_b", "preview", "pv_ctx_b", "p_ctx_branch");
    preview("pv_ctx_b", "sbx_ctx_b", repoId);
    const ctx = resolvePreviewContext({ id: "pv_ctx_b", sandboxId: "sbx_ctx_b", repoId } as never);
    expect(ctx.projectId).toBe("p_ctx_branch");
    expect(ctx.setup?.env).toEqual({ A: "1" });
    expect(ctx.repoRoot).toBe("/work/pv_ctx_b/web");
  });

  it("a worktree preview resolves through its conversation's project and the setup's repo", () => {
    const repoId = project("p_ctx_wt", true)!;
    savePreviewSetup(db(), "p_ctx_wt", setupFor(repoId));
    db().insert(conversations).values({ id: "c_ctx_wt", projectId: "p_ctx_wt", kind: "chat", createdAt: now, updatedAt: now }).run();
    lease("sbx_ctx_wt", "conversation", "c_ctx_wt", "p_ctx_wt");
    const ctx = resolvePreviewContext({ id: "pv_x", sandboxId: "sbx_ctx_wt", repoId: null } as never);
    expect(ctx.projectId).toBe("p_ctx_wt");
    expect(ctx.repoRoot).toBe("/work/c_ctx_wt/web");
  });

  it("a worktree preview in a machine run resolves through the run's project", () => {
    project("p_ctx_run", true);
    db()
      .insert(machineRuns)
      .values({
        id: "mr_ctx_run",
        machineName: "m",
        machineVersion: 1,
        definition: "{}",
        projectId: "p_ctx_run",
        prompt: "x",
        status: "completed",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    lease("sbx_ctx_run", "machine_run", "mr_ctx_run", "p_ctx_run");
    expect(previewProjectId({ id: "pv_y", sandboxId: "sbx_ctx_run", repoId: null } as never)).toBe("p_ctx_run");
  });

  it("no setup → null setup and null repoRoot for a worktree; unknown sandbox → all null", () => {
    project("p_ctx_none", true);
    db().insert(conversations).values({ id: "c_ctx_none", projectId: "p_ctx_none", kind: "chat", createdAt: now, updatedAt: now }).run();
    lease("sbx_ctx_none", "conversation", "c_ctx_none", "p_ctx_none");
    const ctx = resolvePreviewContext({ id: "pv_z", sandboxId: "sbx_ctx_none", repoId: null } as never);
    expect(ctx).toEqual({ projectId: "p_ctx_none", setup: null, repoRoot: null });
    expect(resolvePreviewContext({ id: "pv_q", sandboxId: "sbx_missing", repoId: null } as never)).toEqual({
      projectId: null,
      setup: null,
      repoRoot: null,
    });
  });

  it("a preview-owned lease has no project of its own", () => {
    expect(getLeaseProjectId(db(), { ownerKind: "preview", ownerId: "pv_any" })).toBeNull();
  });
});

describe("0019: project reads", () => {
  it("getProjectOverview: repos, config + shared-with count, setup; null for an unknown project", () => {
    db().insert(sandboxConfigs).values({ id: "cfg_ov", name: "cfg_ov", createdAt: now }).run();
    const repoId = project("p_ov_a", true, "cfg_ov")!;
    project("p_ov_b", false, "cfg_ov");
    savePreviewSetup(db(), "p_ov_a", setupFor(repoId));
    const o = getProjectOverview(db(), "p_ov_a")!;
    expect(o.repos.map((r) => r.name)).toEqual(["web"]);
    expect(o.config?.id).toBe("cfg_ov");
    expect(o.sharedWith).toBe(2);
    expect(o.setup.ok && o.setup.setup?.definition.repo).toBe(repoId);
    expect(getProjectOverview(db(), "p_ov_missing")).toBeNull();
  });

  it("listProjectsWithRepos excludes repo-less projects", () => {
    project("p_lr_yes", true);
    project("p_lr_no", false);
    const ids = listProjectsWithRepos(db()).map((p) => p.id);
    expect(ids).toContain("p_lr_yes");
    expect(ids).not.toContain("p_lr_no");
  });
});
