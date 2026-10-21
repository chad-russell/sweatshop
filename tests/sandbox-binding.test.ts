import path from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import type { Experimental_SandboxSession } from "ai";
import { describe, expect, it } from "vitest";
import { db } from "../db";
import { ensureConversation } from "../db/chat";
import { projects } from "../db/schema";
import { getConversationBinding, getLeaseByOwner } from "../db/sandboxes";
import {
  attachConversation,
  inheritBinding,
  openConversationSandbox,
  openSandbox,
} from "../lib/sandboxes/binding";
import { acquireSandbox } from "../lib/sandboxes/lease";
import type { SandboxHandle, SandboxProvider, SandboxSpec } from "../lib/sandboxes/provider";

/**
 * 0013 Phase 2 — sandbox bindings in chat, against a fake provider: a
 * project chat binds exactly once (pending → bound), attach copies the
 * target's binding (same sandbox, same workDir), opening an inherited
 * binding never touches lifecycle, and the migration folds old
 * `sandbox_pref` rows into bindings.
 */

class FakeProvider implements SandboxProvider {
  readonly kind = "fake";
  log: string[] = [];
  private n = 0;
  create(spec: SandboxSpec): Promise<SandboxHandle> {
    this.n += 1;
    this.log.push(`create ${spec.namePrefix} at ${spec.root}`);
    return Promise.resolve(this.attach(`bind-${this.n}`, spec.root));
  }
  attach(ref: string, root?: string): SandboxHandle {
    this.log.push(`attach ${ref} at ${root}`);
    return {
      ref,
      run: async (command) => {
        this.log.push(`${ref}$ ${command}`);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      spawn: (() => {
        throw new Error("unused");
      }) as unknown as Experimental_SandboxSession["spawn"],
    };
  }
  async stop(ref: string) {
    this.log.push(`stop ${ref}`);
  }
  async resume(ref: string) {
    this.log.push(`resume ${ref}`);
  }
  async destroy(ref: string) {
    this.log.push(`destroy ${ref}`);
  }
}

const lifecycle = (log: string[]) => log.filter((l) => /^(create|stop|destroy) /.test(l));

db().insert(projects).values({ id: "p_bind", name: "Bind", createdAt: 0 }).onConflictDoNothing().run();

describe("0013 sandbox bindings", () => {
  it("a project chat starts pending and binds exactly once", async () => {
    const provider = new FakeProvider();
    ensureConversation(db(), "c_b1", "p_bind");
    expect(getConversationBinding(db(), "c_b1")).toEqual({ kind: "pending", projectId: "p_bind" });

    const first = await openConversationSandbox("c_b1", provider);
    const second = await openConversationSandbox("c_b1", provider);
    expect(first.binding).toEqual({
      kind: "bound",
      sandboxId: first.sandboxId,
      workDir: "/work/c_b1",
      owner: true,
    });
    expect(second.sandboxId).toBe(first.sandboxId);
    expect(getConversationBinding(db(), "c_b1")).toEqual(first.binding);
    expect(lifecycle(provider.log)).toEqual(["create c_b1 at /work/c_b1"]);
  });

  it("plain chats have no sandbox", async () => {
    ensureConversation(db(), "c_b_plain");
    expect(getConversationBinding(db(), "c_b_plain")).toEqual({ kind: "none" });
    await expect(openConversationSandbox("c_b_plain", new FakeProvider())).rejects.toThrow(
      /has no sandbox/,
    );
  });

  it("attach copies the target's binding — same sandbox, same workDir", async () => {
    const provider = new FakeProvider();
    ensureConversation(db(), "c_b_owner", "p_bind");
    const owner = await openConversationSandbox("c_b_owner", provider);

    ensureConversation(db(), "c_b_guest");
    const bound = await attachConversation("c_b_guest", owner.sandboxId, provider);
    expect(bound).toEqual({ ...owner.binding, owner: false });

    provider.log = [];
    const opened = await openConversationSandbox("c_b_guest", provider);
    expect(opened.workDir).toBe("/work/c_b_owner");
    expect(provider.log).toContain(`attach ${opened.handle.ref} at /work/c_b_owner`);
    expect(lifecycle(provider.log)).toEqual([]);
  });

  it("a bound conversation cannot switch sandboxes", async () => {
    const provider = new FakeProvider();
    ensureConversation(db(), "c_b_fixed", "p_bind");
    await openConversationSandbox("c_b_fixed", provider);
    const other = await acquireSandbox(
      { mode: "dedicated", ownerKind: "machine_run", ownerId: "mr_b_other", projectId: null },
      provider,
    );
    await expect(attachConversation("c_b_fixed", other.sandboxId, provider)).rejects.toThrow(
      /already bound/,
    );
  });

  it("an attached chat never gets its own sandbox", async () => {
    const provider = new FakeProvider();
    const run = await acquireSandbox(
      { mode: "dedicated", ownerKind: "machine_run", ownerId: "mr_b_run", projectId: "p_bind" },
      provider,
    );
    ensureConversation(db(), "c_b_proj_guest", "p_bind");
    await attachConversation("c_b_proj_guest", run.sandboxId, provider);
    const opened = await openConversationSandbox("c_b_proj_guest", provider);
    expect(opened.sandboxId).toBe(run.sandboxId);
    expect(opened.workDir).toBe("/work/mr_b_run");
    expect(getLeaseByOwner(db(), "conversation", "c_b_proj_guest")).toBeNull();
  });

  it("opening an inherited binding resumes a stopped sandbox but never stops or destroys", async () => {
    const provider = new FakeProvider();
    ensureConversation(db(), "c_b_life", "p_bind");
    const owner = await openConversationSandbox("c_b_life", provider);
    db().$client.prepare("update sandboxes set status = 'stopped' where id = ?").run(owner.sandboxId);

    provider.log = [];
    await openSandbox(inheritBinding(owner.binding), provider);
    expect(provider.log.filter((l) => /^(resume|stop|destroy|create) /.test(l))).toEqual([
      `resume ${owner.handle.ref}`,
    ]);
  });
});

describe("0013 migration: sandbox_pref → binding", () => {
  it("maps none / attached / own-lease / default rows", () => {
    // Apply migrations up to 0019 on an in-memory db, seed pref rows, then
    // apply 0020–0021 (the binding migration and the column drop) and read
    // the bindings back. In memory: the on-disk replay took seconds.
    const sqlite = new Database(":memory:");
    // 0031: migrations apply with FKs off (schema surgery posture —
    // same as scripts/migrate.mjs and tests/setup.ts).
    sqlite.pragma("foreign_keys = OFF");
    const folder = path.join(process.cwd(), "drizzle");
    const files = readdirSync(folder).filter((f) => f.endsWith(".sql")).sort();
    const run = (file: string) => {
      for (const stmt of readFileSync(path.join(folder, file), "utf8").split("--> statement-breakpoint")) {
        if (stmt.trim()) sqlite.exec(stmt);
      }
    };
    const split = files.findIndex((f) => f.startsWith("0020_"));
    const end = files.findIndex((f) => f.startsWith("0022_"));
    files.slice(0, split).forEach(run);

    sqlite.exec(`
      insert into projects (id, name, created_at) values ('p', 'P', 0);
      insert into sandboxes (id, provider, ref, owner_kind, owner_id, project_id, status, last_used_at, created_at)
        values ('sbx_own', 'podman', 'r1', 'conversation', 'c_own', 'p', 'running', 0, 0),
               ('sbx_run', 'podman', 'r2', 'machine_run', 'mr_x', 'p', 'stopped', 0, 0),
               ('sbx_dead', 'podman', 'r3', 'conversation', 'c_dead', 'p', 'destroyed', 0, 0);
      insert into conversations (id, project_id, sandbox_pref, created_at, updated_at) values
        ('c_none', 'p', 'none', 0, 0),
        ('c_att', null, 'attached:sbx_run', 0, 0),
        ('c_att_missing', 'p', 'attached:sbx_gone', 0, 0),
        ('c_own', 'p', null, 0, 0),
        ('c_dead', 'p', null, 0, 0),
        ('c_fresh', 'p', null, 0, 0),
        ('c_plain', null, null, 0, 0);
    `);
    // 0007 (in the first slice) ends with PRAGMA foreign_keys=ON; restore
    // the migration posture (FKs off) before the slice under test.
    sqlite.pragma("foreign_keys = OFF");
    files.slice(split, end).forEach(run);

    const rows = Object.fromEntries(
      (
        sqlite
          .prepare(
            "select id, sandbox_id, sandbox_work_dir, sandbox_owner, sandbox_disabled from conversations",
          )
          .all() as {
          id: string;
          sandbox_id: string | null;
          sandbox_work_dir: string | null;
          sandbox_owner: number | null;
          sandbox_disabled: number;
        }[]
      ).map((r) => [r.id, [r.sandbox_id, r.sandbox_work_dir, r.sandbox_owner, r.sandbox_disabled]]),
    );
    expect(rows).toEqual({
      c_none: [null, null, null, 1],
      c_att: ["sbx_run", "/work/c_att", 0, 0],
      c_att_missing: [null, null, null, 0],
      c_own: ["sbx_own", "/work/c_own", 1, 0],
      c_dead: [null, null, null, 0],
      c_fresh: [null, null, null, 0],
      c_plain: [null, null, null, 0],
    });
    const cols = (sqlite.prepare("pragma table_info(conversations)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).not.toContain("sandbox_pref");
  });
});
