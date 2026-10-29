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
} from "../db/chat";
import { getConversationBinding } from "../db/sandboxes";
import { conversations, messages, projects, sandboxAttachments } from "../db/schema";
import type { SandboxHandle, SandboxProvider } from "../lib/sandboxes/provider";
import { startThread } from "../lib/agent/tools/start-thread";
import type { Outline } from "../lib/outline";

/**
 * 0037 phase 3 — start_thread: the child conversation (parent, project), the 0013 sandbox choice (attach / own / none), the
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
function setOutline(conversationId: string, outline: Outline) {
  appendMessages(db(), conversationId, [{
    id: `${conversationId}_outline`,
    role: "tool",
    text: "",
    modelMessage: {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: `${conversationId}_outline_call`,
        toolName: "update_outline",
        output: { type: "json", value: { ok: true, version: 1, outline, proposed: false, next: "recorded" } as never },
      }],
    },
  }]);
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

afterAll(() => {
  for (const id of cleanup) {
    db().delete(messages).where(eq(messages.conversationId, id)).run();
    db().delete(sandboxAttachments).where(eq(sandboxAttachments.conversationId, id)).run();
    db().delete(conversations).where(eq(conversations.id, id)).run();
  }
});

describe("startThread", () => {
  it("creates a child on the parent's project, with the parent recorded, and starts its turn", async () => {
    const parent = parentChat("p_st", "attach");
    const started: { id: string; text: string }[] = [];
    const result = await startThread({
      conversationId: parent,
      prompt: "Review branch feature/x against main",
      provider: new FakeProvider(),
      start: async (id, text) => {
        started.push({ id, text });
        return { runId: "wr_child" };
      },
    });
    expect(result).toMatchObject({ ok: true, sandbox: "attached", runId: "wr_child" });
    if (!result.ok) return;
    expect(result.url).toBe(`/c/${result.id}`);
    expect(started).toEqual([{ id: result.id, text: "Review branch feature/x against main" }]);
    const child = getChatChild(db(), result.id);
    expect(child?.parentConversationId).toBe(parent);
    expect(getConversation(db(), result.id)?.projectId).toBe("p_st");
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

  it("takes no skill: the tool schema has none and a child is a plain thread", async () => {
    const { buildChatTools } = await import("../workflows/chat/tools");
    const tools = buildChatTools("c_x", { hasSandbox: true, hasProject: true }) as unknown as Record<
      string,
      { inputSchema: { shape: Record<string, unknown> } }
    >;
    expect(Object.keys(tools.start_thread!.inputSchema.shape).sort()).toEqual(["fresh", "prompt"]);
    const parent = parentChat("p_st", "noskill");
    const result = await startThread({
      conversationId: parent,
      prompt: "look",
      provider: new FakeProvider(),
      start: async () => ({ runId: "wr_c5" }),
    });
    expect(result).not.toHaveProperty("skill");
    if (result.ok) cleanup.push(result.id);
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

describe("startThread: outline runners and handoff (0064 PR2)", () => {
  const outlined = (runner: Outline["steps"][number]["runner"]): Outline => ({
    goal: "Review it",
    steps: [{
      id: "review",
      label: "Review",
      state: "active",
      runner,
      children: [{ id: "diff", label: "Read diff", state: "pending" }],
    }],
  });

  it("allows thread, prepends outline context, and records work_step", async () => {
    const parent = parentChat("p_st", "outline-thread");
    setOutline(parent, outlined("thread"));
    const started: string[] = [];
    const result = await startThread({
      conversationId: parent,
      prompt: "fresh eyes",
      provider: new FakeProvider(),
      start: async (_id, text) => {
        started.push(text);
        return { runId: "wr_outline_thread" };
      },
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(started[0]).toContain("[outline context]\nGoal: Review it\n- Review [active]\n  - Read diff [pending]");
    expect(getChatChild(db(), result.id)?.workStep).toBe("Review");
    cleanup.push(result.id);
  });

  it("refuses self and pinned harness runners before creating a child", async () => {
    for (const [name, runner] of [
      ["outline-self", "self"],
      ["outline-pinned", { harness: "pi", provider: "glm", model: "glm-5.3-flash" }],
    ] as const) {
      const parent = parentChat("p_st", name);
      setOutline(parent, outlined(runner));
      expect(await startThread({ conversationId: parent, prompt: "x", start: async () => ({ runId: "never" }) }))
        .toMatchObject({ ok: false, code: "runner-refused" });
      expect(childrenOf(parent)).toEqual([]);
    }
  });

  it("leaves auto behavior unrestricted", async () => {
    const parent = parentChat("p_st", "outline-auto");
    setOutline(parent, outlined("auto"));
    const result = await startThread({
      conversationId: parent,
      prompt: "x",
      provider: new FakeProvider(),
      start: async () => ({ runId: "wr_outline_auto" }),
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) cleanup.push(result.id);
  });
});
