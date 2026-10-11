import { beforeAll, describe, expect, it } from "vitest";
import type { Experimental_SandboxSession } from "ai";
import { db } from "../db";
import { ensureConversation, getHarnessResumeState, saveHarnessResumeState } from "../db/chat";
import {
  disableConversationSandbox,
  getConversationBinding,
  getLease,
  getLeaseByOwner,
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

  describe("0013 bindings (0031: the binding is the record)", () => {
    it("a bash call binds the chat to the sandbox it created", async () => {
      provider = new FakeProvider();
      ensureConversation(db(), "c_attr", "p_tools");
      await runBash("c_attr", "pwd", provider);
      await runBash("c_attr", "ls", provider);

      const lease = getLeaseByOwner(db(), "conversation", "c_attr")!;
      expect(getConversationBinding(db(), "c_attr")).toEqual({
        kind: "bound",
        sandboxId: lease.id,
        workDir: "/work/c_attr",
        owner: true,
      });
    });

    it("attaching makes the next bash land in the target's sandbox and directory", async () => {
      provider = new FakeProvider();
      ensureConversation(db(), "c_owner2", "p_tools");
      await runBash("c_owner2", "pwd", provider);
      const owner = getLeaseByOwner(db(), "conversation", "c_owner2")!;

      ensureConversation(db(), "c_att2", "p_tools");
      await attachConversationSandbox("c_att2", { sandboxId: owner.id }, provider);
      provider.commands = [];
      await runBash("c_att2", "pwd", provider);

      expect(getConversationBinding(db(), "c_att2")).toMatchObject({
        sandboxId: owner.id,
        workDir: "/work/c_owner2",
        owner: false,
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
      const result = await runBash("c_plain_att", "pwd", provider);
      expect(result.exitCode).toBe(0);
    });

    it("a destroyed sandbox stays as history; its bound chat is told to start fresh", async () => {
      provider = new FakeProvider();
      ensureConversation(db(), "c_gone", "p_tools");
      await runBash("c_gone", "pwd", provider);
      const old = getLeaseByOwner(db(), "conversation", "c_gone")!;

      await destroySandbox(old.id, provider);
      expect(getLeaseByOwner(db(), "conversation", "c_gone")).toBeNull();
      const row = getLease(db(), old.id)!;
      expect(row.status).toBe("destroyed");
      expect(row.destroyedAt).not.toBeNull();

      // 0013: the binding never changes — no silent replacement sandbox
      await expect(runBash("c_gone", "pwd", provider)).rejects.toThrow(
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
    it("maps the binding to its sandbox", async () => {
      provider = new FakeProvider();
      ensureConversation(db(), "c_view", "p_tools");
      const view0 = loadConversationSandboxView(db(), "c_view");
      expect(view0.state).toEqual({ kind: "pending" });
      expect(view0.sandboxes).toEqual({});

      await runBash("c_view", "pwd", provider);
      await runBash("c_view", "pwd", provider);
      const own = getLeaseByOwner(db(), "conversation", "c_view")!;
      const view1 = loadConversationSandboxView(db(), "c_view");
      expect(view1.state).toEqual({ kind: "own", sandboxId: own.id, workDir: "/work/c_view" });
      expect(view1.sandboxes[own.id]).toMatchObject({ own: true, status: "running" });

      const other = await acquireSandbox(
        { mode: "dedicated", ownerKind: "machine_run", ownerId: "run_view", projectId: null },
        provider,
      );
      ensureConversation(db(), "c_view_att");
      await attachConversationSandbox("c_view_att", { sandboxId: other.sandboxId }, provider);
      await runBash("c_view_att", "pwd", provider);
      const view2 = loadConversationSandboxView(db(), "c_view_att");
      expect(view2.state).toEqual({ kind: "attached", sandboxId: other.sandboxId, workDir: "/work/run_view" });
      expect(view2.sandboxes[other.sandboxId]).toMatchObject({ own: false, ownerKind: "machine_run" });

      ensureConversation(db(), "c_view_none", "p_tools");
      disableConversationSandbox(db(), "c_view_none");
      expect(loadConversationSandboxView(db(), "c_view_none").state).toEqual({ kind: "none" });
    });

    it("a plain chat with nothing attached is unavailable", () => {
      ensureConversation(db(), "c_view_plain");
      expect(loadConversationSandboxView(db(), "c_view_plain").state).toEqual({ kind: "unavailable" });
    });

    it("keeps destroyed sandboxes resolvable for the binding", async () => {
      provider = new FakeProvider();
      ensureConversation(db(), "c_view_gone", "p_tools");
      await runBash("c_view_gone", "pwd", provider);
      const old = getLeaseByOwner(db(), "conversation", "c_view_gone")!;
      await destroySandbox(old.id, provider);

      const view = loadConversationSandboxView(db(), "c_view_gone");
      expect(view.sandboxes[old.id]).toMatchObject({ status: "destroyed" });
      // still bound to it (0013); the sandbox ref says it is gone
      expect(view.state).toMatchObject({ kind: "own", sandboxId: old.id });
    });
  });

  describe("0011 sandbox pages", () => {
    it("summarises owners and bound chats; detail lists users", async () => {
      provider = new FakeProvider();
      ensureConversation(db(), "c_pg_owner", "p_tools");
      ensureConversation(db(), "c_pg_guest");
      await runBash("c_pg_owner", "pwd", provider);
      await runBash("c_pg_owner", "ls", provider);
      const lease = getLeaseByOwner(db(), "conversation", "c_pg_owner")!;

      // a guest that attached but has not run anything yet still counts
      await attachConversationSandbox("c_pg_guest", { sandboxId: lease.id }, provider);
      let summary = listSandboxSummaries(db()).find((s) => s.id === lease.id)!;
      expect(summary).toMatchObject({ chats: 2, ownerHref: "/c/c_pg_owner", status: "running" });

      await runBash("c_pg_guest", "echo hi", provider);
      summary = listSandboxSummaries(db()).find((s) => s.id === lease.id)!;
      expect(summary).toMatchObject({ chats: 2 });

      const detail = getSandboxDetail(db(), lease.id)!;
      expect(detail.users.map((u) => [u.conversationId, u.owner])).toEqual([
        ["c_pg_owner", true],
        ["c_pg_guest", false],
      ]);
      expect(getSandboxDetail(db(), "sbx_missing")).toBeNull();
    });

    it("lists destroyed sandboxes after live ones", async () => {
      provider = new FakeProvider();
      ensureConversation(db(), "c_pg_old", "p_tools");
      await runBash("c_pg_old", "pwd", provider);
      const old = getLeaseByOwner(db(), "conversation", "c_pg_old")!;
      await destroySandbox(old.id, provider);
      ensureConversation(db(), "c_pg_new", "p_tools");
      await runBash("c_pg_new", "pwd", provider);

      const all = listSandboxSummaries(db());
      const firstDestroyed = all.findIndex((s) => s.status === "destroyed");
      expect(all.slice(firstDestroyed).every((s) => s.status === "destroyed")).toBe(true);
      expect(all.find((s) => s.id === old.id)).toMatchObject({ status: "destroyed" });
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
      expect(sandboxForHarnessSession(db(), "mr_link1_3")).toMatchObject({ id: owner.sandboxId });
      expect(sandboxForMachineRun(db(), "mr_nothing")).toBeNull();
      expect(sandboxForHarnessSession(db(), "mr_nothing_0")).toBeNull();
    });

    it("a chat's harness session resolves via its binding (0031)", async () => {
      provider = new FakeProvider();
      ensureConversation(db(), "c_link_chat", "p_tools");
      const { sandboxId } = await openConversationSandbox("c_link_chat", provider);
      expect(sandboxForHarnessSession(db(), "c_link_chat")).toMatchObject({
        id: sandboxId,
        note: "own sandbox",
      });
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

    it("project chats get bash/pi/claude/cursor", () => {
      expect(names(true, true)).toEqual(expect.arrayContaining(["bash", "pi", "claude", "cursor"]));
    });
    it("0016: preview tools come with the sandbox", () => {
      const previews = ["start_preview", "preview_status", "stop_preview"];
      expect(names(true, false)).toEqual(expect.arrayContaining(previews));
      for (const t of previews) expect(names(false, true)).not.toContain(t);
    });
    it("chats with no sandbox get none of them", () => {
      for (const hasProject of [true, false]) {
        const tools = names(false, hasProject);
        for (const t of ["bash", "pi", "claude", "cursor"]) expect(tools).not.toContain(t);
      }
    });
    it("a plain chat started attached gets bash only", () => {
      const tools = names(true, false);
      expect(tools).toContain("bash");
      expect(tools).not.toContain("pi");
      expect(tools).not.toContain("claude");
      expect(tools).not.toContain("cursor");
    });
    it("attach_sandbox is gone — attaching is a start-of-chat choice", () => {
      expect(names(true, true)).not.toContain("attach_sandbox");
    });
  });
});

describe("0037 phase 5: the tool catalog after machines", () => {
  it("every chat has start_thread; no machine tool remains", () => {
    const names = (hasSandbox: boolean, hasProject: boolean) =>
      Object.keys(buildChatTools("c_x", { hasSandbox, hasProject }));
    expect(names(false, false)).toContain("start_thread");
    expect(names(true, true)).toContain("cancel_run");
    expect(names(true, true)).toContain("use_playbook");
    for (const gone of ["start_machine", "list_machines", "get_machine", "create_machine", "edit_machine", "delete_machine"]) {
      expect(names(true, true)).not.toContain(gone);
    }
  });
});
