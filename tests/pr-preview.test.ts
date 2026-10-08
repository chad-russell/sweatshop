import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { ensureConversation } from "../db/chat";
import { createProject } from "../db/projects";
import { conversations, gitCredentials, projectRepos, projects } from "../db/schema";
import { buildChatPRPreview, formatPRSummary } from "../lib/agent/tools/pr-preview";

/**
 * 0034 Phase A: the create_pr approval preview — pure formatting, and
 * value-shaped validation (no-project / no-repo / no-credential) before
 * any approval is asked. No sandbox is bound in these tests, so the git
 * gather takes its "unavailable" path — asserting that fallback too.
 */

const rand = Math.random().toString(36).slice(2, 8);
const pid = `pv-${rand}`;
const convId = `c_test_pv_${rand}`;

describe("formatPRSummary", () => {
  it("renders repo, head→base, title, body lead, commits, diffstat", () => {
    const summary = formatPRSummary(
      { repo: "r", head: "feat/x", base: "develop", title: "Fix the thing", body: "Long body\nsecond line" },
      { log: "abc1234 fix\nabc1233 prep", stat: " lib/a.ts | 2 +-\n 1 file changed" },
    );
    expect(summary).toContain('"r"');
    expect(summary).toContain("feat/x → develop");
    expect(summary).toContain("Fix the thing");
    expect(summary).toContain("Body: Long body");
    expect(summary).toContain("abc1234 fix");
    expect(summary).toContain("lib/a.ts | 2 +-");
  });

  it("clips long commit lists and notes why the git summary is absent", () => {
    const log = Array.from({ length: 20 }, (_, i) => `abc120${i} commit ${i}`).join("\n");
    const summary = formatPRSummary({ repo: "r", head: "h", title: "t" }, { log });
    expect(summary).toContain("… (+5 more)");
    const noted = formatPRSummary({ repo: "r", head: "h", title: "t" }, { note: "no sandbox bound" });
    expect(noted).toContain("(no sandbox bound");
  });
});

describe("buildChatPRPreview", () => {
  afterAll(() => {
    db().delete(conversations).where(eq(conversations.id, convId)).run();
    db().delete(projectRepos).where(eq(projectRepos.projectId, pid)).run();
    db().delete(projects).where(eq(projects.id, pid)).run();
  });

  it("refuses a conversation without a project", async () => {
    const plain = `c_test_pv_plain_${rand}`;
    ensureConversation(db(), plain);
    const result = await buildChatPRPreview(plain, { repo: "r", head: "h", title: "t" });
    expect(result).toMatchObject({ ok: false, code: "no-project" });
  });

  it("refuses an unknown repo, then a repo with no matching credential", async () => {
    const created = createProject(db(), {
      id: pid,
      name: "Preview",
      repos: [{ name: "r", url: "https://git.example.io/chad/r" }],
    });
    expect(created.ok).toBe(true);
    ensureConversation(db(), convId, pid);

    const noRepo = await buildChatPRPreview(convId, { repo: "nope", head: "h", title: "t" });
    expect(noRepo).toMatchObject({ ok: false, code: "no-repo" });

    const noCred = await buildChatPRPreview(convId, { repo: "r", head: "h", title: "t" });
    expect(noCred).toMatchObject({ ok: false, code: "no-credential" });
  });

  it("builds the card when the proposal resolves (git summary falls back without a sandbox)", async () => {
    db()
      .insert(gitCredentials)
      .values({
        id: `cred-pv-${rand}`,
        kind: "forgejo",
        label: "test",
        username: "chad",
        secret: "s",
        baseUrl: "https://git.example.io",
        createdAt: Date.now(),
      })
      .run();
    try {
      const result = await buildChatPRPreview(convId, {
        repo: "r",
        head: "feat/x",
        title: "Trial",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summary).toContain('"r"');
        expect(result.summary).toContain("feat/x → main");
        expect(result.summary).toContain("no sandbox bound");
      }
    } finally {
      db().delete(gitCredentials).where(eq(gitCredentials.id, `cred-pv-${rand}`)).run();
    }
  });
});
