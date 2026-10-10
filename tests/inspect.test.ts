import type { Experimental_SandboxSession } from "ai";
import { describe, expect, it } from "vitest";
import { db } from "../db";
import { appendMessages, ensureConversation } from "../db/chat";
import { getConversationBinding, getLease, markDestroyed } from "../db/sandboxes";
import { projects } from "../db/schema";
import { inspectTarget, resolveSandboxTarget, sandboxExec } from "../lib/agent/tools/inspect";
import { openConversationSandbox } from "../lib/sandboxes/binding";
import { recordHarnessEvent, claimHarnessRun } from "../lib/harness-events";
import type { SandboxHandle, SandboxProvider } from "../lib/sandboxes/provider";
import { buildChatTools } from "../workflows/chat/tools";

/**
 * 0013 Phase 6 — inspect and sandbox_exec, post-mortems from outside: a
 * plain chat (no project, no sandbox) can read another chat's or run's
 * state and run a command in its sandbox, in the owner's directory,
 * without binding itself or touching lifecycle.
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
const DEF = JSON.stringify({
  workspace: "project",
  start: "a",
  stages: { a: { kind: "agent", title: "A", instructions: "a", next: [{ to: "end" }] } },
});
let runSeq = 0;
/** A historical run row (0037 phase 5: machines are gone; inspect still reads). */
function mkRun(prompt: string) {
  runSeq += 1;
  const id = `mr_insp_r${runSeq}box`;
  db().$client
    .prepare(
      "insert into machine_runs (id, machine_name, machine_version, definition, project_id, prompt, status, created_at, updated_at) values (?, 'Insp machine', 1, ?, 'p_insp', ?, 'completed', 0, 0)",
    )
    .run(id, DEF, prompt);
  // 0012: a run IS a conversation (kind 'run') — inspect reads it that way.
  db().$client
    .prepare("insert into conversations (id, kind, project_id, created_at, updated_at) values (?, 'run', 'p_insp', 0, 0)")
    .run(id);
  return id;
}
function visit(runId: string, seq: number, stageId: string, kind: string, harness: string | null, patch: string) {
  db().$client
    .prepare(
      `insert into machine_stage_runs (run_id, seq, stage_id, kind, harness, status, session_id, outcome, transition_to, steps, started_at, ended_at) values (?, ?, ?, ?, ?, 'completed', ?, ?, ?, 0, 0, 1)`,
    )
    .run(runId, seq, stageId, kind, harness, `${runId}_${seq}`, ...patch.split("|"));
}

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

  it("reports a run's status, visits, and sandbox", () => {
    const run = mkRun("ship it");
    db().$client
      .prepare(
        "insert into sandboxes (id, provider, ref, owner_kind, owner_id, status, last_used_at, created_at) values ('sbx_insp_run', 'podman', 'r', 'machine_run', ?, 'stopped', 0, 0)",
      )
      .run(run);
    db().$client
      .prepare("update machine_runs set sandbox_id = 'sbx_insp_run', sandbox_work_dir = ?, sandbox_owner = 1 where id = ?")
      .run(`/work/${run}`, run);
    visit(run, 0, "a", "agent", null, "built it|end");

    expect(inspectTarget(run)).toMatchObject({
      kind: "run",
      machine: "Insp machine",
      prompt: "ship it",
      sandbox: { sandboxId: "sbx_insp_run", workDir: `/work/${run}`, status: "stopped" },
      visits: [{ seq: 0, stage: "a", status: "completed", outcome: "built it", to: "end", session: `${run}_0` }],
    });
  });

  it("serves a harness stage visit by its session id (the run hint's pointer)", () => {
    const run = mkRun("qa it");
    db().$client
      .prepare(
        "insert into machine_stage_runs (run_id, seq, stage_id, kind, harness, status, session_id, outcome, transition_to, steps, started_at, ended_at) values (?, 0, 'plan', 'harness', 'pi', 'completed', ?, 'planned', null, 9, 0, 1)",
      )
      .run(run, `${run}_0`);
    claimHarnessRun(`${run}_0`, "pi");
    recordHarnessEvent(`${run}_0`, "pi", { kind: "tool-start", toolName: "bash", input: "ls" });

    const result = inspectTarget(`${run}_0`);
    expect(result).toMatchObject({
      kind: "visit",
      run,
      stage: "plan",
      status: "completed",
      steps: 9,
      outcome: "planned",
      eventsUrl: `/h/pi/${run}_0`,
      harness: { runs: [{ harness: "pi", status: "running" }] },
    });
    // a session id with no matching visit row is still unknown
    expect(inspectTarget(`${run}_7`)).toMatchObject({ kind: "error", code: "unknown-id" });
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

  it("targets a run's sandbox via the run or a stage visit id", () => {
    const run = mkRun("x");
    db().$client
      .prepare(
        "insert into sandboxes (id, provider, ref, owner_kind, owner_id, status, last_used_at, created_at) values ('sbx_insp_r2', 'podman', 'r', 'machine_run', ?, 'running', 0, 0)",
      )
      .run(run);
    db().$client
      .prepare("update machine_runs set sandbox_id = 'sbx_insp_r2', sandbox_work_dir = ?, sandbox_owner = 1 where id = ?")
      .run(`/work/${run}`, run);
    for (const target of [run, `${run}_3`, "sbx_insp_r2"]) {
      expect(resolveSandboxTarget(target)).toEqual({
        kind: "bound",
        sandboxId: "sbx_insp_r2",
        workDir: `/work/${run}`,
        owner: false,
      });
    }
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
