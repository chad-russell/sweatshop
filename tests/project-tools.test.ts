import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { checkNewProject, createProject, setProjectWorkSettings } from "../db/projects";
import { projectRepos, projects } from "../db/schema";
import {
  createProjectPreview,
  deleteProjectPreview,
  editProjectTool,
  listProjectsTool,
} from "../lib/agent/tools/projects";

/**
 * 0033 Phase B: the project tools' cores. The gated tools
 * (create/delete) preview-then-ask exactly like create_machine; these
 * tests cover the cores the tools compose — creation validation and
 * atomicity, the partial-with-report edit, and the delete summary.
 */

const now = Date.now();

const fixtureProject = (id: string) =>
  db()
    .insert(projects)
    .values({ id, name: id.toUpperCase(), createdAt: now })
    .onConflictDoNothing()
    .run();

beforeEach(() => {
  db().$client.exec("delete from project_repos");
  db().$client.exec("delete from projects");
});

describe("createProject (store core)", () => {
  it("creates a project with repos atomically and normalizes .git urls", () => {
    const result = createProject(db(), {
      id: "gpl",
      name: "GPL",
      description: "  employer work  ",
      repos: [{ name: "360-gpl", url: "https://github.com/TangoGroup/360-gpl.git" }],
    });
    expect(result).toMatchObject({ ok: true, project: { id: "gpl", name: "GPL" }, repos: ["360-gpl"] });
    const row = db().select().from(projectRepos).all();
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ id: "gpl/360-gpl", url: "https://github.com/TangoGroup/360-gpl" });
  });

  it("validates without side effects (checkNewProject is the preview)", () => {
    fixtureProject("exists");
    for (const bad of [
      { id: "has space", name: "x" },
      { id: "fine", name: "" },
    ]) {
      expect(checkNewProject(db(), bad).ok).toBe(false);
    }
    // ids normalize to lowercase (the tool schema is strict; the store is lenient)
    expect(checkNewProject(db(), { id: "UPPER", name: "x" })).toMatchObject({ ok: true, id: "upper" });
    expect(checkNewProject(db(), { id: "exists", name: "x" })).toMatchObject({ ok: false, code: "conflict" });
    expect(checkNewProject(db(), { id: "fine", name: "x", repos: [{ name: "a b", url: "https://x.io/r" }] }).ok).toBe(false);
    expect(checkNewProject(db(), { id: "fine", name: "x", repos: [{ name: "a", url: "ftp://x" }] }).ok).toBe(false);
    // a failed create leaves nothing behind
    expect(createProject(db(), { id: "exists", name: "x" }).ok).toBe(false);
    expect(db().select().from(projects).all()).toHaveLength(1);
  });
});

describe("createProjectPreview", () => {
  it("renders the summary Chad approves", () => {
    const result = createProjectPreview({
      id: "gpl",
      name: "GPL",
      repos: [{ name: "360-gpl", url: "https://github.com/TangoGroup/360-gpl" }],
      testCommand: "pnpm test",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toContain("Create project gpl");
      expect(result.summary).toContain("repo 360-gpl");
      expect(result.summary).toContain("pnpm test");
    }
  });
});

describe("editProjectTool", () => {
  it("applies fields partially and reports refusals", () => {
    fixtureProject("editme");
    const result = editProjectTool({
      id: "editme",
      name: "Renamed",
      testCommand: "npm test",
      reposToAdd: [{ name: "web", url: "https://git.example.io/chad/web" }],
      reposToRemove: ["ghost"],
    });
    expect(result).toMatchObject({
      ok: true,
      applied: expect.arrayContaining(["name", "work defaults", "repo +web"]),
      issues: ["repo -ghost: no such repo in this project"],
    });
    const project = db().select().from(projects).where(eq(projects.id, "editme")).get();
    expect(project).toMatchObject({ name: "Renamed", testCommand: "npm test" });
  });

  it("fails outright for a missing project", () => {
    expect(editProjectTool({ id: "nope", name: "x" })).toMatchObject({ ok: false, code: "not-found" });
  });
});

describe("deleteProjectPreview", () => {
  it("summarizes the cascade in numbers", () => {
    fixtureProject("gone");
    const result = deleteProjectPreview("gone");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toContain("Delete project gone");
      expect(result.summary).toContain("cannot be undone");
      expect(result.summary).toContain("Machines and credentials are untouched");
    }
    expect(deleteProjectPreview("nope")).toMatchObject({ ok: false, code: "not-found" });
  });
});

describe("listProjectsTool", () => {
  it("lists projects with repos and work defaults", async () => {
    createProject(db(), {
      id: "gpl",
      name: "GPL",
      repos: [{ name: "360-gpl", url: "https://github.com/TangoGroup/360-gpl" }],
    });
    setProjectWorkSettings(db(), "gpl", { testCommand: "pnpm test" });
    const result = await listProjectsTool();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const gpl = result.projects.find((p) => p.id === "gpl");
      expect(gpl).toMatchObject({
        name: "GPL",
        repos: [{ name: "360-gpl", url: "https://github.com/TangoGroup/360-gpl" }],
        testCommand: "pnpm test",
        branchPrefix: null,
      });
    }
  });
});
