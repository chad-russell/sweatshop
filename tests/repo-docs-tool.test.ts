import { beforeAll, describe, expect, it } from "vitest";
import type { Experimental_SandboxSession } from "ai";
import { ensureConversation } from "../db/chat";
import { db } from "../db";
import { projectRepos, projects } from "../db/schema";
import { loadRepoDocs } from "../lib/agent/tools/repo-docs";
import { runBash } from "../lib/agent/tools/bash";
import type { SandboxHandle, SandboxProvider, SandboxSpec } from "../lib/sandboxes/provider";

/**
 * loadRepoDocs — the top-level agent's repo AGENTS.md read. The point of
 * the fake provider is proving it over-asks nothing: a pending or
 * unbound conversation returns [] without ever calling provider.create
 * (live testing showed none of pi/claude/cursor or this agent ever read
 * a repo's AGENTS.md unprompted; this must not fix that by provisioning
 * a sandbox just to look).
 */

class FakeProvider implements SandboxProvider {
  readonly kind = "fake";
  created: SandboxSpec[] = [];
  private files = new Map<string, string>();
  private n = 0;

  /** Seed a file's content as if `cat`/`head -c` would read it. */
  seed(path: string, content: string) {
    this.files.set(path, content);
  }

  create(spec: SandboxSpec): Promise<SandboxHandle> {
    this.created.push(spec);
    this.n += 1;
    return Promise.resolve(this.handle(`fake-${this.n}`));
  }
  attach(ref: string): SandboxHandle {
    return this.handle(ref);
  }
  async stop() {}
  async resume() {}
  async destroy() {}

  private handle(ref: string): SandboxHandle {
    return {
      ref,
      run: (command) => {
        const match = /head -c \d+ '((?:[^'\\]|\\.)*)'/.exec(command);
        if (match) {
          const content = this.files.get(match[1]);
          return Promise.resolve(
            content === undefined
              ? { exitCode: 1, stdout: "", stderr: "no such file" }
              : { exitCode: 0, stdout: content, stderr: "" },
          );
        }
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      },
      spawn: (() => {
        throw new Error("spawn not needed here");
      }) as unknown as Experimental_SandboxSession["spawn"],
    };
  }
}

describe("loadRepoDocs", () => {
  beforeAll(() => {
    db().insert(projects).values({ id: "p_repodocs", name: "RepoDocs", createdAt: 0 }).onConflictDoNothing().run();
    db()
      .insert(projectRepos)
      .values([
        { id: "p_repodocs/web", projectId: "p_repodocs", name: "web", url: "https://git.example/web.git", createdAt: 0 },
        { id: "p_repodocs/infra", projectId: "p_repodocs", name: "infra", url: "https://git.example/infra.git", createdAt: 0 },
      ])
      .onConflictDoNothing()
      .run();
  });

  it("a plain chat (no project) gets nothing, no provider call", async () => {
    const provider = new FakeProvider();
    ensureConversation(db(), "c_rd_plain");
    expect(await loadRepoDocs("c_rd_plain", provider)).toEqual([]);
    expect(provider.created).toHaveLength(0);
  });

  it("a pending project sandbox (never bound) gets nothing — never provisions one to look", async () => {
    const provider = new FakeProvider();
    ensureConversation(db(), "c_rd_pending", "p_repodocs");
    expect(await loadRepoDocs("c_rd_pending", provider)).toEqual([]);
    expect(provider.created).toHaveLength(0);
  });

  it("a bound sandbox reads each repo's AGENTS.md, dropping repos that have none", async () => {
    const provider = new FakeProvider();
    ensureConversation(db(), "c_rd_bound", "p_repodocs");
    // Bind by using the sandbox once, like a real bash call would.
    await runBash("c_rd_bound", "pwd", provider);
    provider.seed("/work/c_rd_bound/web/AGENTS.md", "Follow the style guide.");
    // infra has no AGENTS.md — left unseeded, so the fake 404s it.

    const docs = await loadRepoDocs("c_rd_bound", provider);
    expect(docs).toEqual([
      { repo: "web", path: "/work/c_rd_bound/web/AGENTS.md", content: "Follow the style guide." },
    ]);
    // The read used the existing bound sandbox — no second create.
    expect(provider.created).toHaveLength(1);
  });
});
