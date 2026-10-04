import { beforeAll, describe, expect, it } from "vitest";
import type { Experimental_SandboxSession } from "ai";
import { db } from "../db";
import { ensureConversation, getHarnessResumeState, saveHarnessResumeState } from "../db/chat";
import {
  disableConversationSandbox,
  getConversationBinding,
  getLease,
  getLeaseByOwner,
  listCallsForConversation,
  listCallsForSandbox,
} from "../db/sandboxes";
import {
  getSandboxDetail,
  listSandboxSummaries,
  loadConversationSandboxView,
  sandboxForHarnessSession,
  sandboxForMachineRun,
} from "../db/sandbox-view";
import { buildChatTools } from "../workflows/chat/tools";
import { projects } from "../db/schema";
import { clipOutput, runBash } from "../lib/agent/tools/bash";
import { attachConversationSandbox } from "../lib/agent/tools/attach-sandbox";
import { openConversationSandbox } from "../lib/sandboxes/binding";
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

  it("bash without a sandbox binding explains itself", async () => {
    provider = new FakeProvider();
    await expect(runBash("c_unbound", "pwd", provider)).rejects.toThrow(
      /this conversation has no sandbox/,
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

  it("attach joins a machine run's sandbox in the run's own workdir (0013)", async () => {
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
    expect(joined).toEqual({ sandboxId: owner.sandboxId, workdir: "/work/run_1" });
    expect(getConversationBinding(db(), "c_joiner")).toEqual({
      kind: "bound",
      sandboxId: owner.sandboxId,
      workDir: "/work/run_1",
      owner: false,
    });

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

    it("attaching makes the next bash land in the target's sandbox and directory", async () => {
      provider = new FakeProvider();
      ensureConversation(db(), "c_owner2", "p_tools");
      await runBash("c_owner2", "pwd", provider, "own_1");
      const owner = getLeaseByOwner(db(), "conversation", "c_owner2")!;

      ensureConversation(db(), "c_att2", "p_tools");
      await attachConversationSandbox("c_att2", { sandboxId: owner.id }, provider);
      provider.commands = [];
      await runBash("c_att2", "pwd", provider, "att_1");

      expect(listCallsForConversation(db(), "c_att2")[0]).toMatchObject({
        sandboxId: owner.id,
        via: "attached",
        workdir: "/work/c_owner2",
      });
      // no new sandbox for the attacher
      expect(provider.commands.filter((c) => c.startsWith("create"))).toEqual([]);
      expect(getLeaseByOwner(db(), "conversation", "c_att2")).toBeNull();
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

    it("a destroyed sandbox stays as history; its bound chat is told to start fresh", async () => {
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

      // 0013: the binding never changes — no silent replacement sandbox
      await expect(runBash("c_gone", "pwd", provider, "gone_2")).rejects.toThrow(
        /was destroyed.*start a new chat/,
      );
      expect(getLeaseByOwner(db(), "conversation", "c_gone")).toBeNull();
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
    it("maps calls to sandboxes and reports the binding", async () => {
      provider = new FakeProvider();
      ensureConversation(db(), "c_view", "p_tools");
      const view0 = loadConversationSandboxView(db(), "c_view");
      expect(view0.state).toEqual({ kind: "pending" });
      expect(view0.calls).toEqual({});

      await runBash("c_view", "pwd", provider, "v_1");
      await runBash("c_view", "pwd", provider, "v_2");
      const own = getLeaseByOwner(db(), "conversation", "c_view")!;
      const view1 = loadConversationSandboxView(db(), "c_view");
      expect(view1.state).toEqual({ kind: "own", sandboxId: own.id, workDir: "/work/c_view" });
      expect(view1.calls.v_1).toEqual({ sandboxId: own.id, via: "dedicated", changed: false });
      expect(view1.calls.v_2).toMatchObject({ changed: false });
      expect(view1.sandboxes[own.id]).toMatchObject({ own: true, status: "running" });

      const other = await acquireSandbox(
        { mode: "dedicated", ownerKind: "machine_run", ownerId: "run_view", projectId: null },
        provider,
      );
      ensureConversation(db(), "c_view_att");
      await attachConversationSandbox("c_view_att", { sandboxId: other.sandboxId }, provider);
      await runBash("c_view_att", "pwd", provider, "v_3");
      const view2 = loadConversationSandboxView(db(), "c_view_att");
      expect(view2.state).toEqual({ kind: "attached", sandboxId: other.sandboxId, workDir: "/work/run_view" });
      expect(view2.calls.v_3).toMatchObject({ via: "attached", changed: false });
      expect(view2.sandboxes[other.sandboxId]).toMatchObject({ own: false, ownerKind: "machine_run" });

      ensureConversation(db(), "c_view_none", "p_tools");
      disableConversationSandbox(db(), "c_view_none");
      expect(loadConversationSandboxView(db(), "c_view_none").state).toEqual({ kind: "none" });
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
      // still bound to it (0013); the sandbox ref says it is gone
      expect(view.state).toMatchObject({ kind: "own", sandboxId: old.id });
    });
  });

  describe("0011 sandbox pages", () => {
    it("summarises owners, call counts and chats; detail lists users and calls", async () => {
      provider = new FakeProvider();
      ensureConversation(db(), "c_pg_owner", "p_tools");
      ensureConversation(db(), "c_pg_guest");
      await runBash("c_pg_owner", "pwd", provider, "pg_1");
      await runBash("c_pg_owner", "ls", provider, "pg_2");
      const lease = getLeaseByOwner(db(), "conversation", "c_pg_owner")!;

      // a guest that attached but has not run anything yet still counts
      await attachConversationSandbox("c_pg_guest", { sandboxId: lease.id }, provider);
      let summary = listSandboxSummaries(db()).find((s) => s.id === lease.id)!;
      expect(summary).toMatchObject({ calls: 2, chats: 2, ownerHref: "/c/c_pg_owner", status: "running" });

      await runBash("c_pg_guest", "echo hi", provider, "pg_3");
      summary = listSandboxSummaries(db()).find((s) => s.id === lease.id)!;
      expect(summary).toMatchObject({ calls: 3, chats: 2 });

      const detail = getSandboxDetail(db(), lease.id)!;
      expect(detail.users.map((u) => [u.conversationId, u.owner, u.calls])).toEqual([
        ["c_pg_owner", true, 2],
        ["c_pg_guest", false, 1],
      ]);
      expect(detail.recentCalls.map((c) => c.toolCallId)).toEqual(["pg_3", "pg_2", "pg_1"]);
      expect(getSandboxDetail(db(), "sbx_missing")).toBeNull();
    });

    it("lists destroyed sandboxes after live ones", async () => {
      provider = new FakeProvider();
      ensureConversation(db(), "c_pg_old", "p_tools");
      await runBash("c_pg_old", "pwd", provider, "old_1");
      const old = getLeaseByOwner(db(), "conversation", "c_pg_old")!;
      await destroySandbox(old.id, provider);
      ensureConversation(db(), "c_pg_new", "p_tools");
      await runBash("c_pg_new", "pwd", provider, "new_1");

      const all = listSandboxSummaries(db());
      const firstDestroyed = all.findIndex((s) => s.status === "destroyed");
      expect(all.slice(firstDestroyed).every((s) => s.status === "destroyed")).toBe(true);
      expect(all.find((s) => s.id === old.id)).toMatchObject({ status: "destroyed", calls: 1 });
    });
  });

  describe("0011 session and run sandbox links", () => {
    it("a machine run resolves to its sandbox, and a stage session id finds it", async () => {
      provider = new FakeProvider();
      const owner = await acquireSandbox(
        { mode: "dedicated", ownerKind: "machine_run", ownerId: "mr_link1", projectId: null },
        provider,
      );
      expect(sandboxForMachineRun(db(), "mr_link1")).toMatchObject({ id: owner.sandboxId, status: "running" });
      expect(sandboxForHarnessSession(db(), "mr_link1_3", "pi")).toMatchObject({ id: owner.sandboxId });
      expect(sandboxForMachineRun(db(), "mr_nothing")).toBeNull();
      expect(sandboxForHarnessSession(db(), "mr_nothing_0", "pi")).toBeNull();
    });

    it("a chat's harness session resolves via its recorded pi/claude calls, per harness", async () => {
      provider = new FakeProvider();
      ensureConversation(db(), "c_link_chat", "p_tools");
      // bash and pi both acquire through the same seam; record a pi call
      const { sandboxId } = await openConversationSandbox("c_link_chat", provider, {
        toolCallId: "link_pi_1",
        tool: "pi",
      });
      expect(sandboxForHarnessSession(db(), "c_link_chat", "pi")).toMatchObject({
        id: sandboxId,
        note: "own sandbox",
      });
      // no claude call was ever recorded for this chat
      expect(sandboxForHarnessSession(db(), "c_link_chat", "claude")).toBeNull();
    });

    it("keeps pointing at a destroyed sandbox, flagged as such", async () => {
      provider = new FakeProvider();
      const owner = await acquireSandbox(
        { mode: "dedicated", ownerKind: "machine_run", ownerId: "mr_link2", projectId: null },
        provider,
      );
      await destroySandbox(owner.sandboxId, provider);
      expect(sandboxForMachineRun(db(), "mr_link2")).toMatchObject({ id: owner.sandboxId, status: "destroyed" });
    });
  });

  describe("0011/0013 tool gating", () => {
    const names = (hasSandbox: boolean, hasProject: boolean) =>
      Object.keys(buildChatTools("c_x", { hasSandbox, hasProject }));

    it("project chats get bash/pi/claude", () => {
      expect(names(true, true)).toEqual(expect.arrayContaining(["bash", "pi", "claude"]));
    });
    it("0016: preview tools come with the sandbox", () => {
      const previews = ["start_preview", "preview_status", "stop_preview"];
      expect(names(true, false)).toEqual(expect.arrayContaining(previews));
      for (const t of previews) expect(names(false, true)).not.toContain(t);
    });
    it("chats with no sandbox get none of them", () => {
      for (const hasProject of [true, false]) {
        const tools = names(false, hasProject);
        for (const t of ["bash", "pi", "claude"]) expect(tools).not.toContain(t);
      }
    });
    it("a plain chat started attached gets bash only", () => {
      const tools = names(true, false);
      expect(tools).toContain("bash");
      expect(tools).not.toContain("pi");
      expect(tools).not.toContain("claude");
    });
    it("attach_sandbox is gone — attaching is a start-of-chat choice", () => {
      expect(names(true, true)).not.toContain("attach_sandbox");
    });
  });
});
