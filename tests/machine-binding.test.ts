import type { Experimental_SandboxSession } from "ai";
import { describe, expect, it } from "vitest";
import { db } from "../db";
import { ensureConversation } from "../db/chat";
import { createMachine, createRun, getRunBinding, bindRun } from "../db/machines";
import { disableConversationSandbox, getConversationBinding, getLeaseByOwner } from "../db/sandboxes";
import { projects } from "../db/schema";
import { startMachineRun } from "../lib/agent/tools/start-machine";
import { openConversationSandbox } from "../lib/sandboxes/binding";
import type { SandboxHandle, SandboxProvider, SandboxSpec } from "../lib/sandboxes/provider";

/**
 * 0013 Phase 3 — machines inherit: start_machine from a project chat
 * passes the chat's binding into the run (same sandbox, same directory;
 * a pending chat is bound first), `fresh` opts out, and a run with an
 * inherited binding is marked non-owner so nothing in the run releases
 * the chat's sandbox.
 */

class FakeProvider implements SandboxProvider {
  readonly kind = "fake";
  created: string[] = [];
  private n = 0;
  create(spec: SandboxSpec): Promise<SandboxHandle> {
    this.n += 1;
    this.created.push(spec.namePrefix);
    return Promise.resolve(this.attach(`mb-${this.n}`));
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

db().insert(projects).values({ id: "p_mb", name: "MB", createdAt: 0 }).onConflictDoNothing().run();
createMachine(db(), {
  id: "mb-build",
  name: "Build",
  definition: {
    workspace: "project",
    start: "build",
    stages: { build: { kind: "agent", title: "Build", instructions: "build", next: [{ to: "end" }] } },
  },
});
createMachine(db(), {
  id: "mb-think",
  name: "Think",
  definition: {
    workspace: "none",
    start: "t",
    stages: { t: { kind: "agent", title: "T", instructions: "t", next: [{ to: "end" }] } },
  },
});

/** startRun stand-in: create the row only (no workflow). */
const createOnly = (async (input: Parameters<typeof createRun>[1]) =>
  createRun(db(), input)) as unknown as NonNullable<Parameters<typeof startMachineRun>[0]["start"]>;

describe("0013 machines inherit the chat's binding", () => {
  it("a run started from a bound chat shares its sandbox and directory", async () => {
    const provider = new FakeProvider();
    ensureConversation(db(), "c_mb1", "p_mb");
    const chat = await openConversationSandbox("c_mb1", provider);

    const started = await startMachineRun({
      conversationId: "c_mb1",
      machineId: "mb-build",
      prompt: "go",
      provider,
      start: createOnly,
    });
    expect(started.sandbox).toBe("inherited");
    expect(getRunBinding(db(), started.runId)).toEqual({
      kind: "bound",
      sandboxId: chat.sandboxId,
      workDir: "/work/c_mb1",
      owner: false,
    });
    // no sandbox of the run's own
    expect(getLeaseByOwner(db(), "machine_run", started.runId)).toBeNull();
    expect(provider.created).toEqual(["c_mb1"]);
  });

  it("a pending chat is bound first, then inherited", async () => {
    const provider = new FakeProvider();
    ensureConversation(db(), "c_mb2", "p_mb");
    const started = await startMachineRun({
      conversationId: "c_mb2",
      machineId: "mb-build",
      prompt: "go",
      provider,
      start: createOnly,
    });
    const chat = getConversationBinding(db(), "c_mb2");
    expect(chat).toMatchObject({ kind: "bound", owner: true, workDir: "/work/c_mb2" });
    expect(getRunBinding(db(), started.runId)).toMatchObject({
      sandboxId: chat?.kind === "bound" ? chat.sandboxId : "",
      owner: false,
    });
  });

  it("fresh: true leaves the run to provision its own", async () => {
    const provider = new FakeProvider();
    ensureConversation(db(), "c_mb3", "p_mb");
    await openConversationSandbox("c_mb3", provider);
    const started = await startMachineRun({
      conversationId: "c_mb3",
      machineId: "mb-build",
      prompt: "go",
      fresh: true,
      provider,
      start: createOnly,
    });
    expect(started.sandbox).toBe("own");
    expect(getRunBinding(db(), started.runId)).toBeNull();
  });

  it("a chat with no sandbox starts a run that provisions its own", async () => {
    const provider = new FakeProvider();
    ensureConversation(db(), "c_mb4", "p_mb");
    disableConversationSandbox(db(), "c_mb4");
    const started = await startMachineRun({
      conversationId: "c_mb4",
      machineId: "mb-build",
      prompt: "go",
      provider,
      start: createOnly,
    });
    expect(started.sandbox).toBe("own");
    expect(provider.created).toEqual([]);
  });

  it("workspace-free machines never inherit", async () => {
    ensureConversation(db(), "c_mb5");
    const started = await startMachineRun({
      conversationId: "c_mb5",
      machineId: "mb-think",
      prompt: "think",
      start: createOnly,
    });
    expect(started.sandbox).toBe("none");
    expect(getRunBinding(db(), started.runId)).toBeNull();
    expect(() =>
      createRun(db(), {
        machineId: "mb-think",
        prompt: "x",
        inherit: { kind: "bound", sandboxId: "sbx_x", workDir: "/work/x", owner: false },
      }),
    ).toThrow(/no workspace to inherit/);
  });

  it("an inherited binding is always recorded as non-owner", async () => {
    const provider = new FakeProvider();
    ensureConversation(db(), "c_mb6", "p_mb");
    const chat = await openConversationSandbox("c_mb6", provider);
    const run = createRun(db(), {
      machineId: "mb-build",
      prompt: "x",
      projectId: "p_mb",
      // even if a caller passes owner: true, inheriting never takes lifecycle
      inherit: { ...chat.binding, owner: true },
    });
    expect(getRunBinding(db(), run.id)?.owner).toBe(false);
  });

  it("a run binds its own sandbox once", () => {
    const run = createRun(db(), { machineId: "mb-build", prompt: "x", projectId: "p_mb" });
    const own = { kind: "bound" as const, sandboxId: "sbx_own1", workDir: `/work/${run.id}`, owner: true };
    db().$client
      .prepare(
        "insert into sandboxes (id, provider, ref, owner_kind, owner_id, status, last_used_at, created_at) values (?, 'fake', 'r', 'machine_run', ?, 'running', 0, 0)",
      )
      .run("sbx_own1", run.id);
    expect(bindRun(db(), run.id, own)).toEqual(own);
    expect(bindRun(db(), run.id, { ...own, sandboxId: "sbx_other" })).toEqual(own);
  });
});
