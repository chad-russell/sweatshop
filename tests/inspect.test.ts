import type { Experimental_SandboxSession } from "ai";
import { describe, expect, it } from "vitest";
import { db } from "../db";
import { appendMessages, ensureConversation, markChatChildWoken, setConversationParent } from "../db/chat";
import { createHarnessCall, settleHarnessCall } from "../db/harness-calls";
import { getConversationBinding, getLease, markDestroyed } from "../db/sandboxes";
import { projects } from "../db/schema";
import { inspectTarget, sandboxExec } from "../lib/agent/tools/inspect";
import { openConversationSandbox } from "../lib/sandboxes/binding";
import { recordHarnessEvent, claimHarnessRun } from "../lib/harness-events";
import type { SandboxHandle, SandboxProvider } from "../lib/sandboxes/provider";
import { buildChatTools } from "../workflows/chat/tools";

/**
 * 0013 Phase 6 — inspect and sandbox_exec, post-mortems from outside: a
 * plain chat (no project, no sandbox) can read another chat's state and
 * run a command in its sandbox, in the owner's directory, without
 * binding itself or touching lifecycle.
 */

class FakeProvider implements SandboxProvider {
  readonly kind = "podman";
  ran: { ref: string; command: string; cwd?: string }[] = [];
  resumed: string[] = [];
  private n = 0;
  async create(): Promise<SandboxHandle> {
    this.n += 1;
    return this.attach(`insp-${this.n}`);
  }
  attach(ref: string, root?: string): SandboxHandle {
    return {
      ref,
      run: async (command, _env, cwd) => {
        this.ran.push({ ref, command, cwd: cwd ?? root });
        return { exitCode: 0, stdout: `out:${command}`, stderr: "" };
      },
      spawn: (() => {
        throw new Error("unused");
      }) as unknown as Experimental_SandboxSession["spawn"],
    };
  }
  async stop() {}
  async resume(ref: string) {
    this.resumed.push(ref);
  }
  async destroy() {}
}

let seq = 0;
function say(conversationId: string, role: "user" | "assistant", text: string) {
  seq += 1;
  appendMessages(db(), conversationId, [
    { id: `insp_m${seq}`, role, text, modelMessage: { role, content: text } as never },
  ]);
}

db().insert(projects).values({ id: "p_insp", name: "Insp", createdAt: 0 }).onConflictDoNothing().run();

describe("0013 inspect", () => {
  it("reports a chat's transcript tail, binding, and harness activity", async () => {
    const provider = new FakeProvider();
    ensureConversation(db(), "c_insp_target", "p_insp");
    say("c_insp_target", "user", "fix the bug");
    say("c_insp_target", "assistant", "done — see the diff");
    const box = await openConversationSandbox("c_insp_target", provider);
    claimHarnessRun("c_insp_target", "pi");
    recordHarnessEvent("c_insp_target", "pi", { kind: "tool-start", toolName: "edit", input: "x" });

    const result = inspectTarget("c_insp_target");
    expect(result).toMatchObject({
      kind: "chat",
      totalMessages: 2,
      sandbox: { sandboxId: box.sandboxId, workDir: "/work/c_insp_target", owner: true, status: "running" },
      harness: { runs: [{ harness: "pi", status: "running" }] },
    });
    expect((result.tail as { text: string }[]).map((m) => m.text)).toEqual(["fix the bug", "done — see the diff"]);
  });

  it("explains unknown ids as values, not throws (a typo'd id must not kill the turn)", () => {
    expect(inspectTarget("c_nope")).toMatchObject({ kind: "error", code: "unknown-id" });
    expect(inspectTarget("mr_typo_9")).toMatchObject({ kind: "error", code: "unknown-id" });
  });
});

describe("0013 sandbox_exec", () => {
  it("runs in the target's sandbox and directory without binding the caller", async () => {
    const provider = new FakeProvider();
    ensureConversation(db(), "c_exec_owner", "p_insp");
    const box = await openConversationSandbox("c_exec_owner", provider);
    db().$client.prepare("update sandboxes set status = 'stopped' where id = ?").run(box.sandboxId);

    ensureConversation(db(), "c_exec_caller"); // plain chat, no project
    provider.ran = [];
    const byChat = await sandboxExec("c_exec_owner", "git log -1", { provider });
    expect(byChat).toMatchObject({ sandboxId: box.sandboxId, workDir: "/work/c_exec_owner", exitCode: 0 });
    expect(provider.resumed).toEqual([box.handle.ref]);
    const byId = await sandboxExec(box.sandboxId, "ls", { provider, workDir: "/tmp" });
    expect(byId.workDir).toBe("/tmp");
    expect(provider.ran.map((r) => [r.command, r.cwd])).toEqual([
      ["git log -1", "/work/c_exec_owner"],
      ["ls", "/tmp"],
    ]);
    // the caller is still unbound; the owner still owns it
    expect(getConversationBinding(db(), "c_exec_caller")).toEqual({ kind: "none" });
    expect(getLease(db(), box.sandboxId)?.status).toBe("running");
  });

  it("refuses targets with no sandbox, and destroyed sandboxes", async () => {
    const provider = new FakeProvider();
    ensureConversation(db(), "c_exec_pending", "p_insp");
    await expect(sandboxExec("c_exec_pending", "ls", { provider })).rejects.toThrow(/has no sandbox/);
    await expect(sandboxExec("c_exec_missing", "ls", { provider })).rejects.toThrow(/no sandbox, chat, or run/);

    ensureConversation(db(), "c_exec_dead", "p_insp");
    const box = await openConversationSandbox("c_exec_dead", provider);
    markDestroyed(db(), box.sandboxId);
    await expect(sandboxExec("c_exec_dead", "ls", { provider })).rejects.toThrow(/was destroyed/);
  });
});

describe("0013 tool availability", () => {
  it("inspect and sandbox_exec are offered everywhere, even without a project or sandbox", () => {
    const tools = Object.keys(buildChatTools("c_x", { hasSandbox: false, hasProject: false }));
    expect(tools).toEqual(expect.arrayContaining(["inspect", "sandbox_exec"]));
    expect(tools).not.toContain("bash");
  });
});

/**
 * 0040 phase 3 (review fix): `resultFile` is read back from the durable
 * column each writer sets (`harnessSettleStep` / `wakeChatChildIfDue`),
 * never derived or guessed — inspect must report a path only when one
 * was actually written, and otherwise say so plainly, never silently
 * point at a file that does not exist.
 */
ensureConversation(db(), "c_insp_rf_parent", "p_insp");

describe("0040 phase 3: inspect's resultFile (review fix)", () => {
  it("hc_: present when a file was actually written", () => {
    const call = createHarnessCall(db(), { conversationId: "c_insp_rf_parent", kind: "pi", task: "x" });
    settleHarnessCall(db(), call.id, { status: "completed", result: "done", resultFile: "/work/c_insp_rf_parent/.sweatshop/results/x.md" });
    expect(inspectTarget(call.id)).toMatchObject({ resultFile: "/work/c_insp_rf_parent/.sweatshop/results/x.md" });
  });

  it("hc_: absent for an empty result (never attempted a write)", () => {
    const call = createHarnessCall(db(), { conversationId: "c_insp_rf_parent", kind: "pi", task: "x" });
    settleHarnessCall(db(), call.id, { status: "completed", result: "" });
    expect(inspectTarget(call.id)).not.toHaveProperty("resultFile");
  });

  it("hc_: absent when the write failed (resultFile left null despite a real result)", () => {
    const call = createHarnessCall(db(), { conversationId: "c_insp_rf_parent", kind: "pi", task: "x" });
    settleHarnessCall(db(), call.id, { status: "completed", result: "done", resultFile: null });
    expect(inspectTarget(call.id)).not.toHaveProperty("resultFile");
  });

  it("c_: present when the child's last settle actually wrote one", () => {
    ensureConversation(db(), "c_insp_child_ok", "p_insp");
    setConversationParent(db(), "c_insp_child_ok", "c_insp_rf_parent");
    markChatChildWoken(db(), "c_insp_child_ok", Date.now(), "/work/c_insp_rf_parent/.sweatshop/results/c_insp_child_ok-1.md");
    expect(inspectTarget("c_insp_child_ok")).toMatchObject({
      resultFile: "/work/c_insp_rf_parent/.sweatshop/results/c_insp_child_ok-1.md",
    });
  });

  it("c_: null (not absent) for a silent child — never settled any report", () => {
    ensureConversation(db(), "c_insp_child_silent", "p_insp");
    setConversationParent(db(), "c_insp_child_silent", "c_insp_rf_parent");
    // setConversationParent pre-stamps woken; no markChatChildWoken call
    // ever ran (nothing to report) — the column stays at its default.
    expect(inspectTarget("c_insp_child_silent")).toMatchObject({ resultFile: null });
  });

  it("c_: null for a cancelled child", () => {
    ensureConversation(db(), "c_insp_child_cancelled", "p_insp");
    setConversationParent(db(), "c_insp_child_cancelled", "c_insp_rf_parent");
    // A prior settle's file must not survive a later cancel.
    markChatChildWoken(db(), "c_insp_child_cancelled", Date.now(), "/work/c_insp_rf_parent/.sweatshop/results/stale.md");
    markChatChildWoken(db(), "c_insp_child_cancelled", Date.now() + 1); // cancel_run's own call shape — no file
    expect(inspectTarget("c_insp_child_cancelled")).toMatchObject({ resultFile: null });
  });

  it("c_: null when the write failed", () => {
    ensureConversation(db(), "c_insp_child_failed", "p_insp");
    setConversationParent(db(), "c_insp_child_failed", "c_insp_rf_parent");
    markChatChildWoken(db(), "c_insp_child_failed", Date.now(), null);
    expect(inspectTarget("c_insp_child_failed")).toMatchObject({ resultFile: null });
  });

  it("not a field at all for a non-child chat", () => {
    ensureConversation(db(), "c_insp_not_a_child", "p_insp");
    expect(inspectTarget("c_insp_not_a_child")).not.toHaveProperty("resultFile");
  });
});
