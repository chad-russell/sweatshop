import type { Experimental_SandboxSession } from "ai";
import { describe, expect, it } from "vitest";
import { db } from "../db";
import { ensureConversation, setActiveRun } from "../db/chat";
import { getLease } from "../db/sandboxes";
import { createMachine, createRun, bindRun } from "../db/machines";
import { projects } from "../db/schema";
import { claimHarnessRun } from "../lib/harness-events";
import { openConversationSandbox } from "../lib/sandboxes/binding";
import {
  boundToSandbox,
  destroySandboxNow,
  reap,
  SandboxActionError,
  stopSandboxNow,
} from "../lib/sandboxes/reaper";
import type { SandboxHandle, SandboxProvider } from "../lib/sandboxes/provider";

/**
 * 0013/0031 — the one sandbox reaper (timer, "Run cleanup now",
 * `npm run sandbox:gc`) and the manual Stop / Destroy, against a fake
 * provider: ONE window for every owner kind (stop 30 min / destroy
 * 7 days), destroyed rows are MARKED, busy sandboxes are never
 * touched, and dry runs change nothing.
 */

const MIN = 60_000;
const DAY = 86_400_000;

class FakeProvider implements SandboxProvider {
  readonly kind = "podman";
  log: string[] = [];
  failOn = new Set<string>();
  private created = 0;
  async create(): Promise<SandboxHandle> {
    this.created += 1;
    return this.attach(`gc-created-${this.created}`);
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
  async stop(ref: string) {
    if (this.failOn.has(ref)) throw new Error(`cannot stop ${ref}`);
    this.log.push(`stop ${ref}`);
  }
  async resume(ref: string) {
    this.log.push(`resume ${ref}`);
  }
  async destroy(ref: string) {
    this.log.push(`destroy ${ref}`);
  }
}

let n = 0;
/** A lease row idle for `idleMs` (unique ids per call). */
function lease(ownerKind: "conversation" | "machine_run", status: string, idleMs: number, ownerId?: string) {
  n += 1;
  const id = `sbx_gc${n}`;
  db().$client
    .prepare(
      "insert into sandboxes (id, provider, ref, owner_kind, owner_id, status, last_used_at, created_at) " +
        "values (?, 'podman', ?, ?, ?, ?, ?, 0)",
    )
    .run(id, `ref-${id}`, ownerKind, ownerId ?? `owner-${id}`, status, Date.now() - idleMs);
  return id;
}
const status = (id: string) => getLease(db(), id)?.status;

db().insert(projects).values({ id: "p_gc", name: "GC", createdAt: 0 }).onConflictDoNothing().run();
createMachine(db(), {
  id: "gc-build",
  name: "GC build",
  definition: {
    workspace: "project",
    start: "b",
    stages: { b: { kind: "agent", title: "B", instructions: "b", next: [{ to: "end" }] } },
  },
});

describe("0013 sandbox reaper", () => {
  it("one window for every owner kind: idle 30m stops, idle 7d destroys", async () => {
    const provider = new FakeProvider();
    const ids = {
      runFresh: lease("machine_run", "running", 5 * MIN),
      runIdle: lease("machine_run", "running", 45 * MIN),
      run4d: lease("machine_run", "stopped", 4 * DAY),
      run8d: lease("machine_run", "stopped", 8 * DAY),
      chat15: lease("conversation", "running", 15 * MIN),
      chat45: lease("conversation", "running", 45 * MIN),
      chat4d: lease("conversation", "stopped", 4 * DAY),
      chat8d: lease("conversation", "stopped", 8 * DAY),
    };
    await reap({ apply: true, provider });
    expect(Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, status(id)]))).toEqual({
      runFresh: "running",
      runIdle: "stopped",
      run4d: "stopped",
      run8d: "destroyed",
      chat15: "running",
      chat45: "stopped",
      chat4d: "stopped",
      chat8d: "destroyed",
    });
    expect(provider.log).toEqual(
      expect.arrayContaining([`stop ref-${ids.runIdle}`, `destroy ref-${ids.run8d}`, `destroy ref-${ids.chat8d}`]),
    );
    expect(provider.log.join(" ")).not.toContain(ids.chat4d);
  });

  it("marks destroyed rows and keeps them as history", async () => {
    const provider = new FakeProvider();
    const id = lease("conversation", "stopped", 20 * DAY, "c_gc_hist");
    await reap({ apply: true, provider });
    expect(getLease(db(), id)).toMatchObject({ status: "destroyed", destroyedAt: expect.any(Number) });
  });

  it("a dry run changes nothing", async () => {
    const provider = new FakeProvider();
    const id = lease("machine_run", "running", 8 * DAY);
    const report = await reap({ apply: false, provider });
    expect(report.actions).toContainEqual(expect.objectContaining({ sandboxId: id, action: "destroy" }));
    expect(status(id)).toBe("running");
    expect(provider.log).toEqual([]);
  });

  it("never touches a sandbox with live work in it", async () => {
    const provider = new FakeProvider();
    // a chat mid-turn
    ensureConversation(db(), "c_gc_busy", "p_gc");
    const chat = await openConversationSandbox("c_gc_busy", provider);
    db().$client.prepare("update sandboxes set last_used_at = ? where id = ?").run(Date.now() - 20 * DAY, chat.sandboxId);
    setActiveRun(db(), "c_gc_busy", "wrun_live");
    // a harness running in an attached chat
    const shared = lease("conversation", "running", 2 * 60 * MIN);
    db().$client
      .prepare("insert into conversations (id, sandbox_id, sandbox_work_dir, sandbox_owner, created_at, updated_at) values ('c_gc_h', ?, '/work/x', 0, 0, 0)")
      .run(shared);
    claimHarnessRun("c_gc_h", "pi");
    // a run waiting at a gate
    const run = createRun(db(), { machineId: "gc-build", prompt: "x", projectId: "p_gc" });
    const runBox = lease("machine_run", "running", 4 * DAY, run.id);
    bindRun(db(), run.id, { kind: "bound", sandboxId: runBox, workDir: `/work/${run.id}`, owner: true });
    db().$client.prepare("update machine_runs set status = 'waiting' where id = ?").run(run.id);

    const report = await reap({ apply: true, provider });
    for (const id of [chat.sandboxId, shared, runBox]) {
      expect(report.actions).toContainEqual(expect.objectContaining({ sandboxId: id, action: "skip-busy" }));
      expect(status(id)).toBe("running");
    }
    await expect(stopSandboxNow(shared, provider)).rejects.toThrow(SandboxActionError);
    await expect(destroySandboxNow(runBox, provider)).rejects.toThrow(/working in this sandbox/);
  });

  it("one failing sandbox does not block the rest", async () => {
    const provider = new FakeProvider();
    const bad = lease("conversation", "running", 60 * MIN);
    const good = lease("conversation", "running", 60 * MIN);
    provider.failOn.add(`ref-${bad}`);
    const report = await reap({ apply: true, provider });
    expect(report.errors).toContainEqual(expect.objectContaining({ sandboxId: bad }));
    expect(status(bad)).toBe("running");
    expect(status(good)).toBe("stopped");
  });

  it("drops stale creating rows only", async () => {
    const provider = new FakeProvider();
    const stale = lease("conversation", "creating", 20 * MIN);
    const fresh = lease("conversation", "creating", 1 * MIN);
    await reap({ apply: true, provider });
    expect(getLease(db(), stale)).toBeNull();
    expect(status(fresh)).toBe("creating");
  });

  it("manual stop and destroy; destroy reports what it strands", async () => {
    const provider = new FakeProvider();
    ensureConversation(db(), "c_gc_man", "p_gc");
    const chat = await openConversationSandbox("c_gc_man", provider);
    expect(boundToSandbox(chat.sandboxId)).toEqual({ conversations: 1, runs: 0 });

    await stopSandboxNow(chat.sandboxId, provider);
    expect(status(chat.sandboxId)).toBe("stopped");
    await stopSandboxNow(chat.sandboxId, provider); // idempotent

    await destroySandboxNow(chat.sandboxId, provider);
    expect(status(chat.sandboxId)).toBe("destroyed");
    await destroySandboxNow(chat.sandboxId, provider); // idempotent
    await expect(stopSandboxNow(chat.sandboxId, provider)).rejects.toThrow(/destroyed/);
    await expect(destroySandboxNow("sbx_nope", provider)).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("0019 the reaper's stop and destroy take the sandbox's services with them", () => {
  const docker = () => {
    const calls: string[][] = [];
    const runner = async (args: string[]) => {
      calls.push(args);
      return "";
    };
    return { calls, runner };
  };
  const withService = (sandboxId: string, status: "running" | "stopped" = "running") => {
    db()
      .$client.prepare(
        "insert into sandbox_services (id, sandbox_id, name, image, ref, status, port, created_at, updated_at) " +
          "values (?, ?, 'db', 'postgres', ?, ?, 5432, 0, 0)",
      )
      .run(`ssvc_${sandboxId}`, sandboxId, `ref-${sandboxId}-svc-db`, status);
  };
  const svcStatus = (sandboxId: string) =>
    (db().$client.prepare("select status from sandbox_services where sandbox_id = ?").get(sandboxId) as { status: string }).status;

  it("idle-stop, manual stop, idle-destroy and manual destroy all reach the services", async () => {
    const provider = new FakeProvider();
    const d = docker();
    const { setServiceDockerForTests } = await import("../lib/sandboxes/services");
    setServiceDockerForTests(d.runner);
    try {
      const idle = lease("conversation", "running", 45 * MIN);
      const old = lease("conversation", "stopped", 15 * DAY);
      const manualStop = lease("conversation", "running", MIN);
      const manualDestroy = lease("conversation", "running", MIN);
      for (const id of [idle, manualStop, manualDestroy]) withService(id);
      withService(old, "stopped"); // an already-stopped sandbox's services were stopped with it

      await reap({ apply: true, provider });
      expect(status(idle)).toBe("stopped");
      expect(svcStatus(idle)).toBe("stopped");
      expect(d.calls).toContainEqual(["stop", `ref-${idle}-svc-db`]);
      expect(status(old)).toBe("destroyed");
      expect(svcStatus(old)).toBe("destroyed");
      expect(d.calls).toContainEqual(["rm", "-f", `ref-${old}-svc-db`]);

      await stopSandboxNow(manualStop, provider);
      expect(svcStatus(manualStop)).toBe("stopped");
      await destroySandboxNow(manualDestroy, provider);
      expect(svcStatus(manualDestroy)).toBe("destroyed");
      expect(d.calls).toContainEqual(["rm", "-f", `ref-${manualDestroy}-svc-db`]);
    } finally {
      setServiceDockerForTests(null);
    }
  });

  it("a service that will not stop never blocks the sandbox's own stop", async () => {
    const provider = new FakeProvider();
    const { setServiceDockerForTests } = await import("../lib/sandboxes/services");
    setServiceDockerForTests(async () => {
      throw new Error("podman wedged");
    });
    try {
      const id = lease("conversation", "running", 45 * MIN);
      withService(id);
      const report = await reap({ apply: true, provider });
      expect(report.errors).toEqual([]);
      expect(status(id)).toBe("stopped");
    } finally {
      setServiceDockerForTests(null);
    }
  });
});
