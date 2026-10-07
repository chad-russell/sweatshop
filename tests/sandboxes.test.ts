import { beforeAll, describe, expect, it } from "vitest";
import type { Experimental_SandboxSession } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { projects } from "../db/schema";
import {
  getLease,
  getLeaseByOwner,
  insertLease,
  listIdleLeases,
  updateLease,
} from "../db/sandboxes";
import {
  acquireSandbox,
  destroySandbox,
  type AcquireRequest,
} from "../lib/sandboxes/lease";
import type { SandboxHandle, SandboxProvider, SandboxSpec } from "../lib/sandboxes/provider";

/**
 * 0010 Phase 2 — the sandbox lease layer against a fake provider. The
 * seam is the point: no containers in the normal gate; provider
 * interactions are recorded and asserted, the store runs on the
 * per-worker temp db, and podman only enters through the (untested
 * here) podmanProvider, whose pieces are docker CLI one-liners.
 */

class FakeProvider implements SandboxProvider {
  readonly kind = "fake";
  created: SandboxSpec[] = [];
  stopped: string[] = [];
  resumed: string[] = [];
  destroyed: string[] = [];
  attached: string[] = [];
  ran: string[] = [];
  private n = 0;

  create(spec: SandboxSpec): Promise<SandboxHandle> {
    this.created.push(spec);
    this.n += 1;
    return Promise.resolve(this.handle(`fake-ref-${this.n}`));
  }

  attach(ref: string): SandboxHandle {
    this.attached.push(ref);
    return this.handle(ref);
  }

  async stop(ref: string) {
    this.stopped.push(ref);
  }
  async resume(ref: string) {
    this.resumed.push(ref);
  }
  async destroy(ref: string) {
    this.destroyed.push(ref);
  }

  private handle(ref: string): SandboxHandle {
    return {
      ref,
      run: async (command) => {
        this.ran.push(`${ref}: ${command}`);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      spawn: (() => {
        throw new Error("spawn not needed in these tests");
      }) as unknown as Experimental_SandboxSession["spawn"],
    };
  }
}

beforeAll(() => {
  db().insert(projects).values({ id: "p1", name: "P1", createdAt: 0 }).onConflictDoNothing().run();
});

function dedicated(ownerId: string): AcquireRequest {
  return { mode: "dedicated", ownerKind: "conversation", ownerId, projectId: "p1" };
}

describe("0010 sandbox leases", () => {
  it("first dedicated acquire creates the lease and the sandbox", async () => {
    const provider = new FakeProvider();
    const { sandboxId, handle } = await acquireSandbox(dedicated("c_a"), provider);

    expect(handle.ref).toBe("fake-ref-1");
    expect(provider.created).toHaveLength(1);
    expect(provider.created[0]!.root).toBe("/work/c_a");
    expect(provider.created[0]!.projectId).toBe("p1");

    const lease = getLease(db(), sandboxId)!;
    expect(lease.status).toBe("running");
    expect(lease.ref).toBe("fake-ref-1");
    expect(lease.ownerKind).toBe("conversation");
  });

  it("re-acquiring the same owner attaches instead of creating", async () => {
    const provider = new FakeProvider();
    await acquireSandbox(dedicated("c_b"), provider);
    const second = await acquireSandbox(dedicated("c_b"), provider);

    expect(provider.created).toHaveLength(1);
    expect(second.handle.ref).toBe("fake-ref-1");
    expect(provider.attached).toContain("fake-ref-1");
    expect(getLeaseByOwner(db(), "conversation", "c_b")!.status).toBe("running");
  });

  it("an idle-stopped lease is resumed on acquire", async () => {
    const provider = new FakeProvider();
    const first = await acquireSandbox(dedicated("c_c"), provider);
    updateLease(db(), first.sandboxId, { status: "stopped" });

    const second = await acquireSandbox(dedicated("c_c"), provider);
    expect(provider.resumed).toEqual(["fake-ref-1"]);
    expect(second.handle.ref).toBe("fake-ref-1");
    expect(getLease(db(), second.sandboxId)!.status).toBe("running");
  });

  it("a failed create leaves no lease row behind", async () => {
    const provider = new FakeProvider();
    provider.create = async () => {
      throw new Error("boom");
    };
    await expect(acquireSandbox(dedicated("c_d"), provider)).rejects.toThrow("boom");
    expect(getLeaseByOwner(db(), "conversation", "c_d")).toBeNull();
  });

  it("destroy removes the sandbox and keeps the registry row as history (0011)", async () => {
    const provider = new FakeProvider();
    const { sandboxId } = await acquireSandbox(dedicated("c_g"), provider);
    await destroySandbox(sandboxId, provider);

    expect(provider.destroyed).toEqual(["fake-ref-1"]);
    expect(getLease(db(), sandboxId)).toMatchObject({ status: "destroyed" });
    expect(getLeaseByOwner(db(), "conversation", "c_g")).toBeNull();
    // destroying twice is a no-op, not a second provider call
    await destroySandbox(sandboxId, provider);
    expect(provider.destroyed).toEqual(["fake-ref-1"]);
  });

  it("the reaper's idle query finds only old running/stopped leases", () => {
    const old = insertLease(db(), {
      provider: "fake",
      ownerKind: "conversation",
      ownerId: "c_old",
      projectId: null,
    });
    const fresh = insertLease(db(), {
      provider: "fake",
      ownerKind: "conversation",
      ownerId: "c_fresh",
      projectId: null,
    });
    const ancient = insertLease(db(), {
      provider: "fake",
      ownerKind: "conversation",
      ownerId: "c_ancient",
      projectId: null,
    });
    updateLease(db(), ancient.id, { status: "stopped" });
    updateLease(db(), old.id, { status: "running" });

    const backdate = db()
      .$client.prepare("update sandboxes set last_used_at = ? where id in (?, ?)")
      .run(Date.now() - 40 * 60_000, old.id, ancient.id);
    expect(backdate.changes).toBe(2);

    const idle = listIdleLeases(db(), Date.now() - 30 * 60_000);
    const ids = idle.map((lease) => lease.id);
    expect(ids).toContain(old.id);
    expect(ids).toContain(ancient.id);
    expect(ids).not.toContain(fresh.id);
  });
});

describe("0013/0031 project image", () => {
  it("creates a project sandbox with its image_ref; unset = provider default", async () => {
    const { projectSandboxImage } = await import("../lib/sandboxes/lease");
    db().insert(projects).values({ id: "p_img", name: "img", imageRef: "localhost/custom:1", createdAt: 0 })
      .onConflictDoNothing().run();
    db().insert(projects).values({ id: "p_noimg", name: "noimg", createdAt: 0 }).onConflictDoNothing().run();

    expect(projectSandboxImage("p_img")).toBe("localhost/custom:1");
    expect(projectSandboxImage("p_noimg")).toBeNull();
    expect(projectSandboxImage("p_missing")).toBeNull();

    const provider = new FakeProvider();
    await acquireSandbox(
      { mode: "dedicated", ownerKind: "conversation", ownerId: "c_img", projectId: "p_img" },
      provider,
    );
    await acquireSandbox(
      { mode: "dedicated", ownerKind: "conversation", ownerId: "c_noimg", projectId: "p_noimg" },
      provider,
    );
    await acquireSandbox(
      { mode: "dedicated", ownerKind: "conversation", ownerId: "c_bare", projectId: null },
      provider,
    );
    expect(provider.created.map((s) => s.image)).toEqual(["localhost/custom:1", undefined, undefined]);

    // setting the image directly takes effect for the next acquire
    db().update(projects).set({ imageRef: "localhost/new-img" }).where(eq(projects.id, "p_noimg")).run();
    expect(projectSandboxImage("p_noimg")).toBe("localhost/new-img");
    db().update(projects).set({ imageRef: null }).where(eq(projects.id, "p_noimg")).run();
    expect(projectSandboxImage("p_noimg")).toBeNull();
  });
});
