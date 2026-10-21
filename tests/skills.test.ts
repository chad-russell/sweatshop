import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { appendMessages, ensureConversation, getConversation, setConversationSkill } from "../db/chat";
import { conversations, messages } from "../db/schema";
import { listSkills, listThreadSkills, readSkill } from "../lib/skills";
import { getTarget, publishEdit, restoreVersion } from "../db/prompt-settings";
import { CONTINUE_TEXT, MAX_CONTINUATIONS, continueAfterBudget, continuationsSinceHuman } from "../lib/chat/budget";
import { POST as postChat } from "../app/api/x/chat/route";
import { loadSkillStep, skillToolStep } from "../workflows/chat/steps/turn";

/**
 * 0039: skills (markdown runbooks under skills/<id>/SKILL.md; thread
 * skills bind to a conversation) and the bounded budget continuation of
 * a thread-skill turn (0037 phase 2, carried over).
 */

const ids: string[] = [];
function conv(name: string) {
  const id = `c_test_sk_${name}_${Math.random().toString(36).slice(2, 8)}`;
  ensureConversation(db(), id);
  ids.push(id);
  return id;
}

afterAll(() => {
  for (const id of ids) {
    db().delete(messages).where(eq(messages.conversationId, id)).run();
    db().delete(conversations).where(eq(conversations.id, id)).run();
  }
});

describe("skill files", () => {
  it("ship parses: title from the H1, description from front matter, body without it", async () => {
    const ship = await readSkill("ship");
    expect(ship?.title).toMatch(/^Ship/);
    expect(ship?.description).toMatch(/PR/);
    expect(ship?.body.startsWith("# Ship")).toBe(true);
    expect(ship?.body).toContain("create_pr");
    expect((await listSkills()).map((b) => b.id)).toContain("ship");
  });

  it("ticket and review parse and carry their phase-3 shape", async () => {
    const ticket = await readSkill("ticket");
    expect(ticket?.title).toMatch(/^Ticket/);
    expect(ticket?.body).toContain("present_plan");
    expect(ticket?.body).toContain("accept_plan");
    expect(ticket?.body).toContain("start_thread");
    expect(ticket?.body).toContain("create_pr");
    const review = await readSkill("review");
    expect(review?.title).toMatch(/^Review/);
    // The review thread changes nothing and reports findings.
    expect(review?.body).toContain("Change nothing");
    expect(review?.body).toMatch(/blocking/i);
    expect((await listSkills()).map((b) => b.id).sort()).toEqual(["review", "review-guide", "ship", "ticket"]);
  });

  it("review-guide parses: a tour that changes nothing and flags look-closely spots", async () => {
    const guide = await readSkill("review-guide");
    expect(guide?.title).toMatch(/^Review guide/);
    expect(guide?.description).toMatch(/tour/i);
    expect(guide?.body).toContain("**Look closely**");
    expect(guide?.body).toContain("Change nothing");
    expect(guide?.thread).toBe(true);
  });

  it("rejects traversal and unknown ids", async () => {
    for (const bad of ["../machines", "nope", "Ship", ""]) expect(await readSkill(bad)).toBeNull();
  });
});

describe("budget continuation", () => {
  const chip = (id: string, n: number, kind: "budget" | "harness") =>
    appendMessages(db(), id, [
      {
        id: `${id}_w${n}`,
        role: "user",
        text: "wake",
        modelMessage: { role: "user", content: "wake" },
        metadata: { runEvent: { kind, id: "x", status: "s" } },
      },
    ]);
  const human = (id: string, n: number) =>
    appendMessages(db(), id, [{ id: `${id}_h${n}`, role: "user", text: "hi", modelMessage: { role: "user", content: "hi" } }]);

  it("counts budget wakes since Chad's last message, ignoring other wakes", () => {
    const id = conv("count");
    chip(id, 1, "budget");
    human(id, 2);
    chip(id, 3, "budget");
    chip(id, 4, "harness");
    chip(id, 5, "budget");
    expect(continuationsSinceHuman(id)).toBe(2);
  });

  it("continues until the bound, then stops", async () => {
    const id = conv("bound");
    const started: string[] = [];
    const start = async (_id: string, text: string) => void started.push(text);
    expect(await continueAfterBudget(id, { start })).toBe("continued");
    expect(started).toEqual([CONTINUE_TEXT]);
    for (let i = 0; i < MAX_CONTINUATIONS; i += 1) chip(id, 10 + i, "budget");
    expect(await continueAfterBudget(id, { start })).toBe("bounded");
    expect(started).toHaveLength(1);
  });
});

describe("chat route skill binding", () => {
  it("rejects an unknown skill before creating anything", async () => {
    const id = `c_test_sk_bad_${Math.random().toString(36).slice(2, 8)}`;
    const res = await postChat(
      new Request("http://x/api/x/chat", {
        method: "POST",
        body: JSON.stringify({ conversationId: id, text: "hi", skill: "nope" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(getConversation(db(), id)).toBeNull();
  });

  it("stores the thread's skill, and only thread skills are bindable", async () => {
    const id = conv("store");
    setConversationSkill(db(), id, "review");
    expect(getConversation(db(), id)?.skill).toBe("review");
    // The bindable catalog is thread skills only — the flag, not the
    // directory, decides (a plain reference skill never appears). 0055:
    // ship ships disabled (retired) so it never appears here either.
    expect((await listThreadSkills()).map((s) => s.id).sort()).toEqual(["review", "review-guide", "ticket"]);
    expect((await listSkills()).every((s) => typeof s.thread === "boolean")).toBe(true);
  });
});

describe("0059: use_skill loads an active skill without binding a non-mode", () => {
  it("loads an active thread skill's body and leaves the conversation unbound", async () => {
    const id = conv("bind_active");
    const result = await skillToolStep(id, "review");
    expect(result).toMatchObject({ ok: true, id: "review", mode: false });
    expect((result as { skill?: string }).skill).toContain("review");
    expect(getConversation(db(), id)?.skill).toBeNull();
  });

  for (const status of ["disabled", "deleted"] as const) {
    it(`rejects a ${status} skill without changing an existing binding`, async () => {
      const id = conv(`bind_${status}`);
      setConversationSkill(db(), id, "review");
      const target = { kind: "skill" as const, id: "ship" };
      const original = getTarget(db(), target)!;
      expect(publishEdit(db(), target, { patch: { status }, expectedVersion: original.version })).toMatchObject({ ok: true });
      try {
        // Existing bindings still resolve through readSkill, independently
        // of whether the skill is offered for new use_skill calls.
        expect((await readSkill("ship"))?.id).toBe("ship");
        const result = await skillToolStep(id, "ship") as { ok: boolean; code: string; skills: { id: string }[] };
        expect(result).toMatchObject({ ok: false, code: "unknown-skill" });
        expect(result.skills.map((s) => s.id)).not.toContain("ship");
        expect(getConversation(db(), id)?.skill).toBe("review");
      } finally {
        const live = getTarget(db(), target)!;
        expect(publishEdit(db(), target, { patch: { status: original.status }, expectedVersion: live.version })).toMatchObject({ ok: true });
      }
    });
  }

  it("keeps resolving an already-bound skill after it is disabled", async () => {
    const id = conv("already_bound");
    setConversationSkill(db(), id, "ship");
    const target = { kind: "skill" as const, id: "ship" };
    const original = getTarget(db(), target)!;
    expect(publishEdit(db(), target, { patch: { status: "disabled" }, expectedVersion: original.version })).toMatchObject({ ok: true });
    try {
      expect(await loadSkillStep(id)).toMatchObject({ id: "ship", body: original.body });
    } finally {
      const live = getTarget(db(), target)!;
      expect(publishEdit(db(), target, { patch: { status: original.status }, expectedVersion: live.version })).toMatchObject({ ok: true });
    }
  });
});

describe("0054: DB-backed status — disable/delete hide from catalogs, never from a bound read", () => {
  it("0055: ship ships disabled (retired) by default — still in listSkills and readSkill, never bindable", async () => {
    const ship = getTarget(db(), { kind: "skill", id: "ship" })!;
    expect(ship.status).toBe("disabled");
    expect((await listThreadSkills()).map((s) => s.id)).not.toContain("ship");
    expect((await listSkills()).map((s) => s.id)).toContain("ship");
    expect((await readSkill("ship"))?.body.startsWith("# Ship")).toBe(true);
  });

  it("disabling review drops it from the bindable catalog but not from listSkills or readSkill", async () => {
    const live = getTarget(db(), { kind: "skill", id: "review" })!;
    expect(live.status).toBe("active");
    expect(
      publishEdit(db(), { kind: "skill", id: "review" }, { patch: { status: "disabled" }, expectedVersion: live.version }),
    ).toMatchObject({ ok: true });

    // Not bindable to a new thread...
    expect((await listThreadSkills()).map((s) => s.id)).not.toContain("review");
    // ...but still in the general catalog, and readSkill (the path an
    // already-bound thread's loadSkillStep uses) ignores status entirely.
    expect((await listSkills()).map((s) => s.id)).toContain("review");
    expect((await readSkill("review"))?.body.startsWith("# Review")).toBe(true);

    // Leave it as found, for any test that runs after this one.
    const disabled = getTarget(db(), { kind: "skill", id: "review" })!;
    publishEdit(db(), { kind: "skill", id: "review" }, { patch: { status: "active" }, expectedVersion: disabled.version });
  });

  it("deleting (tombstoning) ticket drops it from both catalogs; restoring the pre-delete version undoes it", async () => {
    const live = getTarget(db(), { kind: "skill", id: "ticket" })!;
    publishEdit(db(), { kind: "skill", id: "ticket" }, { patch: { status: "deleted" }, expectedVersion: live.version });

    expect((await listThreadSkills()).map((s) => s.id)).not.toContain("ticket");
    expect((await listSkills()).map((s) => s.id)).not.toContain("ticket");
    // A deleted skill is a tombstone, not a removed row: readSkill still
    // resolves it (an already-bound thread keeps running).
    expect((await readSkill("ticket"))?.title).toMatch(/^Ticket/);

    const tombstoned = getTarget(db(), { kind: "skill", id: "ticket" })!;
    expect(
      restoreVersion(
        db(),
        { kind: "skill", id: "ticket" },
        { version: live.version, expectedVersion: tombstoned.version },
      ),
    ).toMatchObject({ ok: true });
    expect((await listThreadSkills()).map((s) => s.id)).toContain("ticket");
  });
});

describe("owner placeholders in skill display text", () => {
  it("renders {{owner}} in description at read time, body stays raw", async () => {
    const prev = process.env.SWEATSHOP_OWNER_NAME;
    process.env.SWEATSHOP_OWNER_NAME = "Riley";
    const target = { kind: "skill" as const, id: "review" };
    const original = getTarget(db(), target)!;
    expect(publishEdit(db(), target, { patch: { description: "Ask {{owner}} about {{owner's}} call" }, expectedVersion: original.version })).toMatchObject({ ok: true });
    try {
      const want = "Ask Riley about Riley's call";
      const read = await readSkill("review");
      expect(read?.description).toBe(want);
      expect(read?.body).toBe(original.body);
      expect((await listSkills()).find((s) => s.id === "review")?.description).toBe(want);
      expect((await listThreadSkills()).find((s) => s.id === "review")?.description).toBe(want);
    } finally {
      const live = getTarget(db(), target)!;
      publishEdit(db(), target, { patch: { description: original.description }, expectedVersion: live.version });
      if (prev === undefined) delete process.env.SWEATSHOP_OWNER_NAME;
      else process.env.SWEATSHOP_OWNER_NAME = prev;
    }
  });

  it("no shipped SKILL.md front-matter description contains a placeholder", () => {
    const root = join(__dirname, "..", "skills");
    for (const dir of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const text = readFileSync(join(root, dir.name, "SKILL.md"), "utf8");
      const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
      const desc = /^description:\s*(.*)$/m.exec(fm)?.[1] ?? "";
      expect(desc, dir.name).not.toContain("{{");
    }
  });
});
