import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../db";
import { projectRepos, projects } from "../db/schema";
import { REPO_DOC_FILE_CAP } from "../lib/agent/repo-docs";
import type { SandboxShell } from "../lib/sandbox-shell";
import { buildWorkRootDoc, setupProjectWorkspace, type WorkRootRepo } from "../lib/sandboxes/workspace";

/**
 * The harnesses' work-root AGENTS.md/CLAUDE.md (pi/claude/cursor start
 * with cwd at the work root, not inside a repo — live testing showed
 * none of them read a repo's AGENTS.md unprompted). buildWorkRootDoc is
 * pure; setupProjectWorkspace's write is covered against a recording
 * fake shell, no real sandbox needed.
 */

describe("buildWorkRootDoc", () => {
  it("headers the root, lists repos, and skips repos with no AGENTS.md", () => {
    const repos: WorkRootRepo[] = [
      { name: "web", agentsMd: "Use the style guide." },
      { name: "infra", agentsMd: null },
    ];
    const doc = buildWorkRootDoc("/work/c1", repos);
    expect(doc).toContain("This is a sweatshop work root");
    expect(doc).toContain("Read each repo's AGENTS.md before working in it");
    expect(doc).toContain("repo checkouts below");
    expect(doc).toContain("- web: /work/c1/web");
    expect(doc).toContain("- infra: /work/c1/infra");
    expect(doc).toContain("# web AGENTS.md (/work/c1/web/AGENTS.md)\n\nUse the style guide.");
    expect(doc).not.toContain("infra AGENTS.md");
  });

  it("caps an inlined AGENTS.md and points at the full file", () => {
    const content = "z".repeat(REPO_DOC_FILE_CAP + 1_000);
    const doc = buildWorkRootDoc("/work/c1", [{ name: "big", agentsMd: content }]);
    expect(doc.length).toBeLessThan(content.length);
    expect(doc).toContain("cat /work/c1/big/AGENTS.md");
  });

  it("stops inlining past the total budget and points at the omitted files", () => {
    const big = "x".repeat(20 * 1024);
    const doc = buildWorkRootDoc("/w", [
      { name: "a", agentsMd: big },
      { name: "b", agentsMd: big },
      { name: "c", agentsMd: big },
    ]);
    expect(doc).toContain("# a AGENTS.md");
    expect(doc).toContain("# b AGENTS.md");
    expect(doc).not.toContain("# c AGENTS.md");
    expect(doc).toContain("cat /w/c/AGENTS.md");
  });

  it("is idempotent — the same inputs build the same doc", () => {
    const repos: WorkRootRepo[] = [{ name: "web", agentsMd: "x" }];
    expect(buildWorkRootDoc("/work/c1", repos)).toBe(buildWorkRootDoc("/work/c1", repos));
  });

  it("produces a sensible doc with no repos", () => {
    const doc = buildWorkRootDoc("/work/c1", []);
    expect(doc).toContain("sweatshop work root");
    expect(doc).toContain("Repos:");
  });
});

/** Records every command; answers `head -c` reads from a path→content
 *  map (missing path = non-zero exit, same as a real missing file). */
class FakeShell implements SandboxShell {
  commands: string[] = [];
  constructor(private files: Record<string, string> = {}) {}

  run(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.commands.push(command);
    const headMatch = /^head -c \d+ '((?:[^'\\]|\\.)*)'/.exec(command);
    if (headMatch) {
      const path = headMatch[1];
      const content = this.files[path];
      return Promise.resolve(
        content === undefined
          ? { exitCode: 1, stdout: "", stderr: "no such file" }
          : { exitCode: 0, stdout: content, stderr: "" },
      );
    }
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
  }
}

describe("setupProjectWorkspace writes the work-root doc", () => {
  const pid = `p_wsdoc_${Math.random().toString(36).slice(2, 8)}`;

  it("writes AGENTS.md and CLAUDE.md beside the repos, never inside one, and is idempotent", async () => {
    db().insert(projects).values({ id: pid, name: "WS Doc", createdAt: 0 }).run();
    db()
      .insert(projectRepos)
      .values({ id: `${pid}/web`, projectId: pid, name: "web", url: "https://git.example/web.git", createdAt: 0 })
      .run();

    const shell = new FakeShell({ "/work/wsdoc/web/AGENTS.md": "Follow the style guide." });
    await setupProjectWorkspace(shell, pid, "/work/wsdoc");

    const writeCmd = shell.commands.find((c) => c.includes("base64 -d >"));
    expect(writeCmd).toBeDefined();
    expect(writeCmd).toContain("> /work/wsdoc/AGENTS.md");
    expect(writeCmd).toContain("cp /work/wsdoc/AGENTS.md /work/wsdoc/CLAUDE.md");
    expect(writeCmd).not.toMatch(/>\s*\/work\/wsdoc\/web\//);

    const encoded = /base64 -d > /.test(writeCmd!) ? writeCmd!.match(/printf %s '([^']*)'/)?.[1] : undefined;
    expect(encoded).toBeDefined();
    const written = Buffer.from(encoded!, "base64").toString("utf8");
    expect(written).toContain("# web AGENTS.md (/work/wsdoc/web/AGENTS.md)\n\nFollow the style guide.");
    expect(written).toContain("- web: /work/wsdoc/web");

    // Re-running (e.g. a second setup pass) overwrites rather than erroring.
    const before = shell.commands.length;
    await setupProjectWorkspace(shell, pid, "/work/wsdoc");
    expect(shell.commands.length).toBeGreaterThan(before);

    db().delete(projectRepos).where(eq(projectRepos.projectId, pid)).run();
    db().delete(projects).where(eq(projects.id, pid)).run();
  });
});
