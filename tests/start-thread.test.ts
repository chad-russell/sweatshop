import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Experimental_SandboxSession } from "ai";
import { db } from "../db";
import {
  appendMessages,
  ensureConversation,
  getChatChild,
  getConversation,
  listWakableChatChildren,
  setConversationMode,
} from "../db/chat";
import { getConversationBinding } from "../db/sandboxes";
import { getTarget } from "../db/prompt-settings";
import { conversations, messages, projects, sandboxAttachments } from "../db/schema";
import type { SandboxHandle, SandboxProvider } from "../lib/sandboxes/provider";
import { startThread } from "../lib/agent/tools/start-thread";
import { applyApprovedPromptChangeStep } from "../workflows/chat/steps/prompt-change";

/**
 * 0037 phase 3 — start_thread: the child conversation (parent, project,
 * skill), the 0013 sandbox choice (attach / own / none), the
 * pre-stamped wake marker, and the turn-start seam.
 */

class FakeProvider implements SandboxProvider {
  readonly kind = "fake";
  private n = 0;
  create(): Promise<SandboxHandle> {
    this.n += 1;
    return Promise.resolve(this.attach(`sbx_fake_${this.n}`));
  }
  attach(ref: string): SandboxHandle {
    return {
      ref,
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      spawn: (() => {
        throw new Error("unused");
      }) as unknown as Experimental_SandboxSession["spawn"],
    };
  }
  async stop() {}
  async resume() {}
  async destroy() {}
}

db().insert(projects).values({ id: "p_st", name: "ST", createdAt: 0 }).onConflictDoNothing().run();

const cleanup: string[] = [];
function parentChat(project: string | null, name: string) {
  const id = `c_st_${name}`;
  ensureConversation(db(), id, project);
  cleanup.push(id);
  return id;
}
/** The child rows a test minted (start_thread generates the ids). */
function childrenOf(parent: string) {
  return db()
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.parentConversationId, parent))
    .all()
    .map((row) => row.id);
}

/** 0055 v7 part B: a mode skill with two phases, created fresh per id. */
async function createPhaseMode(id: string) {
  const target = getTarget(db(), { kind: "skill", id });
  await applyApprovedPromptChangeStep(
    { kind: "skill", id },
    {
      body: "# Handoff Test\n\nBrief, orchestrator-only.\n\n## Shared\n\nShared convention text.\n\n## Phase: Plan\n\nPlan phase body.\n\n## Phase: Implement\n\nImplement phase body.",
      description: "test mode",
      thread: true,
      mode: true,
      status: "active",
    },
    target?.version ?? 0,
    "test: create phase mode",
  );
}

/** A fresh parent chat moded into `modeId` at `phase` (or legacy/bound-only when null). */
function modedParent(project: string | null, name: string, modeId: string, phase: string | null) {
  const id = parentChat(project, name);
  if (phase !== null) setConversationMode(db(), id, modeId, phase);
  else db().update(conversations).set({ skill: modeId }).where(eq(conversations.id, id)).run();
  return id;
}

afterAll(() => {
  for (const id of cleanup) {
    db().delete(messages).where(eq(messages.conversationId, id)).run();
    db().delete(sandboxAttachments).where(eq(sandboxAttachments.conversationId, id)).run();
    db().delete(conversations).where(eq(conversations.id, id)).run();
  }
});

describe("startThread", () => {
  it("creates a child on the parent's project, with the skill and parent recorded, and starts its turn", async () => {
    const parent = parentChat("p_st", "attach");
    const started: { id: string; text: string }[] = [];
    const result = await startThread({
      conversationId: parent,
      prompt: "Review branch feature/x against main",
      skill: "review",
      provider: new FakeProvider(),
      start: async (id, text) => {
        started.push({ id, text });
        return { runId: "wr_child" };
      },
    });
    expect(result).toMatchObject({ ok: true, sandbox: "attached", skill: "review", runId: "wr_child" });
    if (!result.ok) return;
    expect(result.url).toBe(`/c/${result.id}`);
    expect(started).toEqual([{ id: result.id, text: "Review branch feature/x against main" }]);
    const child = getChatChild(db(), result.id);
    expect(child?.parentConversationId).toBe(parent);
    expect(getConversation(db(), result.id)?.projectId).toBe("p_st");
    expect(getConversation(db(), result.id)?.skill).toBe("review");
    // The creation bump is not a settle: woken starts at updatedAt.
    expect(child?.wokenSettledAt).toBe(child?.updatedAt);
    // 0013 attach: same sandbox and directory as the (now bound) parent
    // — but the child never owns the sandbox (it cannot stop/destroy it).
    const childBinding = getConversationBinding(db(), result.id);
    const parentBinding = getConversationBinding(db(), parent);
    expect(childBinding).toMatchObject({
      kind: "bound",
      sandboxId: parentBinding?.kind === "bound" ? parentBinding.sandboxId : undefined,
      workDir: parentBinding?.kind === "bound" ? parentBinding.workDir : undefined,
      owner: false,
    });
    cleanup.push(result.id);
  });

  it("attaches through a pending parent binding (the parent binds first)", async () => {
    const parent = parentChat("p_st", "pending");
    expect(getConversationBinding(db(), parent)).toMatchObject({ kind: "pending" });
    const result = await startThread({
      conversationId: parent,
      prompt: "look",
      provider: new FakeProvider(),
      start: async () => ({ runId: "wr_c2" }),
    });
    expect(result).toMatchObject({ ok: true, sandbox: "attached" });
    expect(getConversationBinding(db(), parent)).toMatchObject({ kind: "bound" });
    if (result.ok) cleanup.push(result.id);
  });

  it("fresh gives the child its own (lazily provisioned) sandbox", async () => {
    const parent = parentChat("p_st", "fresh");
    const result = await startThread({
      conversationId: parent,
      prompt: "look",
      fresh: true,
      provider: new FakeProvider(),
      start: async () => ({ runId: "wr_c3" }),
    });
    expect(result).toMatchObject({ ok: true, sandbox: "own" });
    // A project child stays pending — its own sandbox provisions on
    // its first sandboxed call, like any project chat.
    expect(getConversationBinding(db(), result.ok ? result.id : "")).toMatchObject({ kind: "pending" });
    if (result.ok) cleanup.push(result.id);
  });

  it("a no-sandbox parent gets a no-sandbox child", async () => {
    const parent = parentChat(null, "plain");
    const result = await startThread({
      conversationId: parent,
      prompt: "look",
      provider: new FakeProvider(),
      start: async () => ({ runId: "wr_c4" }),
    });
    expect(result).toMatchObject({ ok: true, sandbox: "none" });
    expect(getConversationBinding(db(), result.ok ? result.id : "")).toMatchObject({
      kind: "none",
      disabled: true,
    });
    if (result.ok) cleanup.push(result.id);
  });

  it("rejects an unknown skill before creating anything", async () => {
    const parent = parentChat("p_st", "badpb");
    const result = await startThread({
      conversationId: parent,
      prompt: "look",
      skill: "nope",
      start: async () => ({ runId: "wr_c5" }),
    });
    expect(result).toMatchObject({ ok: false, code: "no-skill" });
    expect(childrenOf(parent)).toEqual([]);
  });

  it("reports a start failure as a value (the child row stays, silent)", async () => {
    const parent = parentChat("p_st", "startfail");
    const result = await startThread({
      conversationId: parent,
      prompt: "look",
      provider: new FakeProvider(),
      start: async () => {
        throw new Error("workflow down");
      },
    });
    expect(result).toMatchObject({ ok: false, code: "start-failed" });
    const [child] = childrenOf(parent);
    expect(child).toBeTruthy();
    // No turn ever ran: no messages, so the wake sweep will stamp it
    // woken without delivering anything.
    const childRow = getChatChild(db(), child!);
    expect(childRow?.wokenSettledAt).toBe(childRow?.updatedAt);
    appendMessages(db(), child!, [
      {
        id: `${child}_m1`,
        role: "assistant",
        text: "partial",
        modelMessage: { role: "assistant", content: "partial" },
      },
    ]);
    // Force the ordering a real turn guarantees (same-ms collisions
    // would read "already woken").
    db()
      .update(conversations)
      .set({ updatedAt: Date.now() + 1000 })
      .where(eq(conversations.id, child!))
      .run();
    const after = getChatChild(db(), child!)!;
    expect(after.updatedAt).toBeGreaterThan(after.wokenSettledAt ?? 0);
    expect(listWakableChatChildren(db()).map((c) => c.id)).toContain(child!);
    cleanup.push(child!);
  });
});

describe("startThread: phase handoff (0055 v7 part B)", () => {
  it("wraps the child's first-turn prompt with the handoff and records conversations.work_phase", async () => {
    await createPhaseMode("st-handoff-1");
    const parent = modedParent("p_st", "handoff1", "st-handoff-1", "plan");
    const started: { id: string; text: string }[] = [];
    const result = await startThread({
      conversationId: parent,
      prompt: "look at the diff on branch x",
      provider: new FakeProvider(),
      start: async (id, text) => {
        started.push({ id, text });
        return { runId: "wr_h1" };
      },
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(started[0]!.text).toContain('You are doing the "Plan" phase of a "Handoff Test" run.');
    expect(started[0]!.text).toContain("Shared convention text.");
    expect(started[0]!.text).toContain("Plan phase body.");
    expect(started[0]!.text).not.toContain("Implement phase body.");
    expect(started[0]!.text).toContain("Task from the orchestrator:\nlook at the diff on branch x");
    expect(getChatChild(db(), result.id)?.workPhase).toBe("Plan");
    cleanup.push(result.id);
  });

  it("an explicit phase arg overrides the parent's current phase", async () => {
    await createPhaseMode("st-handoff-2");
    const parent = modedParent("p_st", "handoff2", "st-handoff-2", "plan");
    const started: { text: string }[] = [];
    const result = await startThread({
      conversationId: parent,
      prompt: "look",
      phase: "implement",
      provider: new FakeProvider(),
      start: async (_id, text) => {
        started.push({ text });
        return { runId: "wr_h2" };
      },
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(started[0]!.text).toContain("Implement phase body.");
    expect(getChatChild(db(), result.id)?.workPhase).toBe("Implement");
    cleanup.push(result.id);
  });

  it("an unknown phase refuses before creating anything", async () => {
    await createPhaseMode("st-handoff-3");
    const parent = modedParent("p_st", "handoff3", "st-handoff-3", "plan");
    const result = await startThread({
      conversationId: parent,
      prompt: "look",
      phase: "sprint",
      start: async () => ({ runId: "wr_h3" }),
    });
    expect(result).toMatchObject({ ok: false, code: "unknown-phase" });
    if (!result.ok) {
      expect(result.message).toContain("Plan");
      expect(result.message).toContain("Implement");
    }
    expect(childrenOf(parent)).toEqual([]);
  });

  it("phase given on a non-moded parent refuses before creating anything", async () => {
    const parent = parentChat("p_st", "handoff4");
    const result = await startThread({
      conversationId: parent,
      prompt: "look",
      phase: "plan",
      start: async () => ({ runId: "wr_h4" }),
    });
    expect(result).toMatchObject({ ok: false, code: "not-moded" });
    expect(childrenOf(parent)).toEqual([]);
  });

  it("a non-moded parent's child prompt is unchanged (byte-identical) — no wrapping", async () => {
    const parent = parentChat("p_st", "handoff5");
    const started: { text: string }[] = [];
    const result = await startThread({
      conversationId: parent,
      prompt: "plain prompt, no mode",
      provider: new FakeProvider(),
      start: async (_id, text) => {
        started.push({ text });
        return { runId: "wr_h5" };
      },
    });
    expect(result).toMatchObject({ ok: true });
    expect(started[0]!.text).toBe("plain prompt, no mode");
    if (result.ok) {
      expect(getChatChild(db(), result.id)?.workPhase).toBeNull();
      cleanup.push(result.id);
    }
  });

  it("a legacy mode-skill parent (skill bound, mode_phase null) does not wrap either", async () => {
    await createPhaseMode("st-handoff-6");
    const parent = modedParent("p_st", "handoff6", "st-handoff-6", null);
    const started: { text: string }[] = [];
    const result = await startThread({
      conversationId: parent,
      prompt: "plain",
      provider: new FakeProvider(),
      start: async (_id, text) => {
        started.push({ text });
        return { runId: "wr_h6" };
      },
    });
    expect(result).toMatchObject({ ok: true });
    expect(started[0]!.text).toBe("plain");
    if (result.ok) cleanup.push(result.id);
  });
});
