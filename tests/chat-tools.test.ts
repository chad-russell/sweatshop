import { beforeAll, describe, expect, it } from "vitest";
import type { Experimental_SandboxSession } from "ai";
import { db } from "../db";
import { ensureConversation } from "../db/chat";
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
});
