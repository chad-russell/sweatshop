import { beforeAll, describe, expect, it } from "vitest";
import type { Experimental_SandboxSession } from "ai";
import { db } from "../db";
import {
  ensureConversation,
  getConversation,
  getHarnessResumeState,
  saveHarnessResumeState,
  updateConversationSettings,
} from "../db/chat";
import { getLease, getLeaseByOwner, listCallsForConversation, listCallsForSandbox } from "../db/sandboxes";
import { loadConversationSandboxView } from "../db/sandbox-view";
import { buildChatTools } from "../workflows/chat/tools";
import { projects } from "../db/schema";
import { clipOutput, runBash } from "../lib/agent/tools/bash";
import { attachConversationSandbox } from "../lib/agent/tools/attach-sandbox";
import { acquireSandbox, destroySandbox } from "../lib/sandboxes/lease";
import type { SandboxHandle, SandboxProvider, SandboxSpec } from "../lib/sandboxes/provider";

/**
 * 0010 Phase 3 — the chat tool cores (bash, attach) against a fake
 * provider on the per-worker temp db. The workflow steps that wrap
 * these are thin (proven by the turn tests' machinery); harness tools
 * (pi/claude) are their own port and are not covered here.
 */

class FakeProvider implements SandboxProvider {
  readonly kind = "fake";
  commands: string[] = [];
  private n = 0;

  create(spec: SandboxSpec): Promise<SandboxHandle> {
    this.n += 1;
    this.commands.push(`create ${spec.projectId} at ${spec.root}`);
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
      run: async (command) => {
        this.commands.push(`${ref}$ ${command}`);
        return { exitCode: 0, stdout: `ran: ${command}`, stderr: "" };
      },
      spawn: (() => {
        throw new Error("spawn not needed here");
      }) as unknown as Experimental_SandboxSession["spawn"],
    };
  }
}

describe("0010 chat tool cores", () => {
  let provider: FakeProvider;

  beforeAll(() => {
    db().insert(projects).values({ id: "p_tools", name: "Tools", createdAt: 0 }).onConflictDoNothing().run();
    ensureConversation(db(), "c_bound", "p_tools");
    ensureConversation(db(), "c_unbound");
  });

  it("bash runs in the conversation's dedicated sandbox (lazy create)", async () => {
    provider = new FakeProvider();
    const result = await runBash("c_bound", "pwd", provider);
    expect(result.stdout).toBe("ran: pwd");
    // created once with the conversation's project and workdir
    expect(provider.commands[0]).toBe("create p_tools at /work/c_bound");
    // then executed
    expect(provider.commands[1]).toBe("fake-1$ pwd");

    // a second call reuses the sandbox (no second create)
    await runBash("c_bound", "ls", provider);
    expect(provider.commands.filter((c) => c.startsWith("create"))).toHaveLength(1);
  });

  it("bash without a project fails with the 0004 explanation", async () => {
    provider = new FakeProvider();
    await expect(runBash("c_unbound", "pwd", provider)).rejects.toThrow(
      /no project bound to this conversation/,
    );
  });

  it("clipOutput keeps head and tail of oversized output", () => {
    const clipped = clipOutput("a".repeat(30_000));
    expect(clipped.length).toBeLessThan(30_000);
    expect(clipped).toContain("chars clipped");
    expect(clipped.startsWith("a")).toBe(true);
    expect(clipped.endsWith("a")).toBe(true);
    expect(clipOutput("short")).toBe("short");
  });

  it("attach joins a machine run's sandbox with the conversation's workdir", async () => {
    provider = new FakeProvider();
    const owner = await acquireSandbox(
      { mode: "dedicated", ownerKind: "machine_run", ownerId: "run_1", projectId: null },
      provider,
    );
    ensureConversation(db(), "c_joiner");

    const joined = await attachConversationSandbox(
      "c_joiner",
      { ownerKind: "machine_run", ownerId: "run_1" },
      provider,
    );
    expect(joined.sandboxId).toBe(owner.sandboxId);
    expect(joined.workdir).toBe("/work/c_joiner");
    // the joiner's workdir was created inside the sandbox
    expect(provider.commands.some((c) => c.includes("mkdir -p \"/work/c_joiner\""))).toBe(true);

    await destroySandbox(owner.sandboxId, provider);
  });

  it("attach to a missing owner explains itself", async () => {
    provider = new FakeProvider();
    await expect(
      attachConversationSandbox("c_joiner", { ownerKind: "machine_run", ownerId: "run_none" }, provider),
    ).rejects.toThrow(/no sandbox for machine_run run_none/);
  });

  it("harness resume state round-trips per conversation × kind", () => {
    ensureConversation(db(), "c_harness");
    const handle = { harnessId: "pi", data: { session: "s1" } };
    saveHarnessResumeState(db(), "c_harness", "pi", handle);
    saveHarnessResumeState(db(), "c_harness", "claude", { harnessId: "claude" });
    expect(getHarnessResumeState(db(), "c_harness", "pi")).toEqual(handle);
    expect(getHarnessResumeState(db(), "c_harness", "claude")).toEqual({ harnessId: "claude" });
    expect(getHarnessResumeState(db(), "c_harness", "pi")).not.toEqual({ harnessId: "claude" });
    expect(getHarnessResumeState(db(), "c_other", "pi")).toBeNull();

    const updated = { harnessId: "pi", data: { session: "s2" } };
    saveHarnessResumeState(db(), "c_harness", "pi", updated);
    expect(getHarnessResumeState(db(), "c_harness", "pi")).toEqual(updated);
  });

  describe("0011 sandbox attribution", () => {
    it("records the sandbox a bash call actually ran in", async () => {
      provider = new FakeProvider();
      ensureConversation(db(), "c_attr", "p_tools");
      await runBash("c_attr", "pwd", provider, "call_1");
      await runBash("c_attr", "ls", provider, "call_2");

      const lease = getLeaseByOwner(db(), "conversation", "c_attr")!;
      const calls = listCallsForConversation(db(), "c_attr");
      expect(calls.map((c) => c.toolCallId)).toEqual(["call_1", "call_2"]);
      expect(calls.every((c) => c.sandboxId === lease.id && c.via === "dedicated")).toBe(true);
      expect(calls[0]).toMatchObject({ tool: "bash", workdir: "/work/c_attr" });
      expect(listCallsForSandbox(db(), lease.id)).toHaveLength(2);
    });

    it("re-recording the same toolCallId (step retry) keeps one row", async () => {
      provider = new FakeProvider();
      ensureConversation(db(), "c_retry", "p_tools");
      await runBash("c_retry", "pwd", provider, "call_r");
      await runBash("c_retry", "pwd", provider, "call_r");
      expect(listCallsForConversation(db(), "c_retry")).toHaveLength(1);
    });

    it("a pref change mid-chat attributes later calls to the new sandbox", async () => {
      provider = new FakeProvider();
      ensureConversation(db(), "c_mix", "p_tools");
      const owner = await acquireSandbox(
        { mode: "dedicated", ownerKind: "machine_run", ownerId: "run_mix", projectId: null },
        provider,
      );
      await runBash("c_mix", "echo own", provider, "mix_1");

      updateConversationSettings(db(), "c_mix", { sandboxPref: `attached:${owner.sandboxId}` });
      await runBash("c_mix", "echo shared", provider, "mix_2");

      const [first, second] = listCallsForConversation(db(), "c_mix");
      expect(first).toMatchObject({ toolCallId: "mix_1", via: "dedicated" });
      expect(second).toMatchObject({ toolCallId: "mix_2", via: "attached", sandboxId: owner.sandboxId });
      expect(first!.sandboxId).not.toBe(second!.sandboxId);
    });

    it("attach_sandbox sets the pref so the next bash lands in the attached sandbox", async () => {
      provider = new FakeProvider();
      ensureConversation(db(), "c_att2", "p_tools");
      const owner = await acquireSandbox(
        { mode: "dedicated", ownerKind: "machine_run", ownerId: "run_att2", projectId: null },
        provider,
      );
      await attachConversationSandbox("c_att2", { sandboxId: owner.sandboxId }, provider);
      expect(getConversation(db(), "c_att2")!.sandboxPref).toBe(`attached:${owner.sandboxId}`);

      await runBash("c_att2", "pwd", provider, "att_1");
      expect(listCallsForConversation(db(), "c_att2")[0]).toMatchObject({
        sandboxId: owner.sandboxId,
        via: "attached",
      });
    });

    it("a plain chat can run bash after attaching", async () => {
      provider = new FakeProvider();
      ensureConversation(db(), "c_plain_att");
      const owner = await acquireSandbox(
        { mode: "dedicated", ownerKind: "machine_run", ownerId: "run_plain", projectId: null },
        provider,
      );
      await attachConversationSandbox("c_plain_att", { sandboxId: owner.sandboxId }, provider);
      const result = await runBash("c_plain_att", "pwd", provider, "plain_1");
      expect(result.exitCode).toBe(0);
    });

    it("a destroyed sandbox stays as history and its owner can get a fresh one", async () => {
      provider = new FakeProvider();
      ensureConversation(db(), "c_gone", "p_tools");
      await runBash("c_gone", "pwd", provider, "gone_1");
      const old = getLeaseByOwner(db(), "conversation", "c_gone")!;

      await destroySandbox(old.id, provider);
      expect(getLeaseByOwner(db(), "conversation", "c_gone")).toBeNull();
      const row = getLease(db(), old.id)!;
      expect(row.status).toBe("destroyed");
      expect(row.destroyedAt).not.toBeNull();
      expect(listCallsForSandbox(db(), old.id)).toHaveLength(1);

      await runBash("c_gone", "pwd", provider, "gone_2");
      const fresh = getLeaseByOwner(db(), "conversation", "c_gone")!;
      expect(fresh.id).not.toBe(old.id);
      expect(listCallsForConversation(db(), "c_gone").map((c) => c.sandboxId)).toEqual([old.id, fresh.id]);
    });

    it("attaching to a destroyed sandbox is refused", async () => {
      provider = new FakeProvider();
      ensureConversation(db(), "c_dead");
      const owner = await acquireSandbox(
        { mode: "dedicated", ownerKind: "machine_run", ownerId: "run_dead", projectId: null },
        provider,
      );
      await destroySandbox(owner.sandboxId, provider);
      await expect(
        attachConversationSandbox("c_dead", { sandboxId: owner.sandboxId }, provider),
      ).rejects.toThrow(/no sandbox/);
    });
  });

  describe("0011 sandbox view", () => {
    it("maps calls to sandboxes, flags a change, and reports current state", async () => {
      provider = new FakeProvider();
      ensureConversation(db(), "c_view", "p_tools");
      const view0 = loadConversationSandboxView(db(), "c_view");
      expect(view0.state).toEqual({ kind: "pending" });
      expect(view0.calls).toEqual({});

      await runBash("c_view", "pwd", provider, "v_1");
      const own = getLeaseByOwner(db(), "conversation", "c_view")!;
      const view1 = loadConversationSandboxView(db(), "c_view");
      expect(view1.state).toEqual({ kind: "own", sandboxId: own.id });
      expect(view1.calls.v_1).toEqual({ sandboxId: own.id, via: "dedicated", changed: false });
      expect(view1.sandboxes[own.id]).toMatchObject({ own: true, status: "running" });

      const other = await acquireSandbox(
        { mode: "dedicated", ownerKind: "machine_run", ownerId: "run_view", projectId: null },
        provider,
      );
      updateConversationSettings(db(), "c_view", { sandboxPref: `attached:${other.sandboxId}` });
      await runBash("c_view", "pwd", provider, "v_2");
      await runBash("c_view", "pwd", provider, "v_3");

      const view2 = loadConversationSandboxView(db(), "c_view");
      expect(view2.state).toEqual({ kind: "attached", sandboxId: other.sandboxId });
      expect(view2.calls.v_2).toMatchObject({ via: "attached", changed: true });
      expect(view2.calls.v_3).toMatchObject({ via: "attached", changed: false });
      expect(view2.sandboxes[other.sandboxId]).toMatchObject({ own: false, ownerKind: "machine_run" });

      updateConversationSettings(db(), "c_view", { sandboxPref: "none" });
      expect(loadConversationSandboxView(db(), "c_view").state).toEqual({ kind: "none" });
    });

    it("a plain chat with nothing attached is unavailable", () => {
      ensureConversation(db(), "c_view_plain");
      expect(loadConversationSandboxView(db(), "c_view_plain").state).toEqual({ kind: "unavailable" });
    });

    it("keeps destroyed sandboxes resolvable for past calls", async () => {
      provider = new FakeProvider();
      ensureConversation(db(), "c_view_gone", "p_tools");
      await runBash("c_view_gone", "pwd", provider, "g_1");
      const old = getLeaseByOwner(db(), "conversation", "c_view_gone")!;
      await destroySandbox(old.id, provider);

      const view = loadConversationSandboxView(db(), "c_view_gone");
      expect(view.sandboxes[old.id]).toMatchObject({ status: "destroyed" });
      expect(view.calls.g_1!.sandboxId).toBe(old.id);
      expect(view.state).toEqual({ kind: "pending" });
    });
  });

  describe("0011 tool gating", () => {
    const names = (pref: string | null, hasProject: boolean) =>
      Object.keys(buildChatTools("c_x", pref, hasProject));

    it("project chats get bash/pi/claude", () => {
      expect(names(null, true)).toEqual(expect.arrayContaining(["bash", "pi", "claude"]));
    });
    it("plain chats get none of them", () => {
      const tools = names(null, false);
      for (const t of ["bash", "pi", "claude"]) expect(tools).not.toContain(t);
    });
    it("a plain chat that attached gets bash only", () => {
      const tools = names("attached:sbx_1", false);
      expect(tools).toContain("bash");
      expect(tools).not.toContain("pi");
      expect(tools).not.toContain("claude");
    });
    it("pref none removes them everywhere", () => {
      for (const t of ["bash", "pi", "claude"]) expect(names("none", true)).not.toContain(t);
    });
  });
});
