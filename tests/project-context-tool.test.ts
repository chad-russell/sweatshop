import { beforeAll, describe, expect, it } from "vitest";
import { ensureConversation } from "../db/chat";
import { db } from "../db";
import { projectRepos, projects } from "../db/schema";
import { loadProjectContext } from "../lib/agent/tools/project-context";

/**
 * loadProjectContext — the top-level agent's own-project read (RCA: a
 * project chat was never told which project it was in, so it called
 * list_projects to find "the relevant project"). Plain sync db read,
 * same shape as loadRepoDocs's test but with no sandbox involved.
 */

describe("loadProjectContext", () => {
  beforeAll(() => {
    db()
      .insert(projects)
      .values({
        id: "p_ctx",
        name: "Context Co",
        description: "Keeps the agent honest about where it is.",
        testCommand: "npm test",
        branchPrefix: "ctx",
        createdAt: 0,
      })
      .onConflictDoNothing()
      .run();
    db()
      .insert(projects)
      .values({ id: "p_ctx_bare", name: "Bare", createdAt: 0 })
      .onConflictDoNothing()
      .run();
    db()
      .insert(projectRepos)
      .values([
        { id: "p_ctx/web", projectId: "p_ctx", name: "web", url: "https://git.example/web.git", createdAt: 0 },
        { id: "p_ctx/infra", projectId: "p_ctx", name: "infra", url: "https://git.example/infra.git", createdAt: 0 },
      ])
      .onConflictDoNothing()
      .run();
  });

  it("a plain chat (no project) gets null", () => {
    ensureConversation(db(), "c_pc_plain");
    expect(loadProjectContext("c_pc_plain")).toBeNull();
  });

  it("an unknown conversation gets null", () => {
    expect(loadProjectContext("c_pc_missing")).toBeNull();
  });

  it("a project conversation gets the project's full shape", () => {
    ensureConversation(db(), "c_pc_full", "p_ctx");
    expect(loadProjectContext("c_pc_full")).toEqual({
      id: "p_ctx",
      name: "Context Co",
      description: "Keeps the agent honest about where it is.",
      repos: [
        { name: "web", url: "https://git.example/web.git" },
        { name: "infra", url: "https://git.example/infra.git" },
      ],
      testCommand: "npm test",
      branchPrefix: "ctx",
    });
  });

  it("a project with no description/test command/branch prefix/repos nulls and empties them, not omits them", () => {
    ensureConversation(db(), "c_pc_bare", "p_ctx_bare");
    expect(loadProjectContext("c_pc_bare")).toEqual({
      id: "p_ctx_bare",
      name: "Bare",
      description: null,
      repos: [],
      testCommand: null,
      branchPrefix: null,
    });
  });
});
