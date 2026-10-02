import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

/**
 * 0013 Phase 4 — scripts/sandbox-gc.mjs against a scratch db and a stub
 * container engine (records its argv, lists no containers): windows are
 * per owner kind (runs 10 min / 3 days, chats 30 min / 14 days), and a
 * destroyed sandbox's row is MARKED destroyed, never deleted — its
 * recorded calls keep their target.
 */

const MIN = 60_000;
const DAY = 86_400_000;

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), "sweatshop-gc-"));
  const dbPath = path.join(dir, "gc.db");
  const sqlite = new Database(dbPath);
  const folder = path.join(process.cwd(), "drizzle");
  for (const file of readdirSync(folder).filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(path.join(folder, file), "utf8").split("--> statement-breakpoint")) {
      if (stmt.trim()) sqlite.exec(stmt);
    }
  }
  const log = path.join(dir, "engine.log");
  const engine = path.join(dir, "engine");
  writeFileSync(engine, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\n`);
  chmodSync(engine, 0o755);
  return { dir, dbPath, sqlite, engine, log };
}

function lease(
  sqlite: Database.Database,
  id: string,
  ownerKind: "conversation" | "machine_run",
  status: string,
  idleMs: number,
) {
  sqlite
    .prepare(
      "insert into sandboxes (id, provider, ref, owner_kind, owner_id, status, last_used_at, created_at) " +
        "values (?, 'podman', ?, ?, ?, ?, ?, 0)",
    )
    .run(id, `ref-${id}`, ownerKind, `owner-${id}`, status, Date.now() - idleMs);
}

function gc(env: { dbPath: string; engine: string }, apply: boolean) {
  return execFileSync("node", ["scripts/sandbox-gc.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      SWEATSHOP_DB: env.dbPath,
      GC_ENGINE: env.engine,
      ...(apply ? { GC_APPLY: "1" } : {}),
    },
  });
}

describe("sandbox-gc (0013)", () => {
  it("reaps runs on the short window and chats on the long one", () => {
    const env = scratch();
    lease(env.sqlite, "run_fresh", "machine_run", "running", 5 * MIN);
    lease(env.sqlite, "run_idle", "machine_run", "running", 15 * MIN);
    lease(env.sqlite, "run_old", "machine_run", "stopped", 4 * DAY);
    lease(env.sqlite, "chat_idle_15", "conversation", "running", 15 * MIN);
    lease(env.sqlite, "chat_idle_45", "conversation", "running", 45 * MIN);
    lease(env.sqlite, "chat_4d", "conversation", "stopped", 4 * DAY);
    lease(env.sqlite, "chat_old", "conversation", "stopped", 15 * DAY);

    gc(env, true);
    const status = Object.fromEntries(
      (env.sqlite.prepare("select id, status from sandboxes").all() as { id: string; status: string }[]).map(
        (r) => [r.id, r.status],
      ),
    );
    expect(status).toEqual({
      run_fresh: "running",
      run_idle: "stopped",
      run_old: "destroyed",
      chat_idle_15: "running",
      chat_idle_45: "stopped",
      chat_4d: "stopped",
      chat_old: "destroyed",
    });
    const engineCalls = readFileSync(env.log, "utf8");
    expect(engineCalls).toContain("stop ref-run_idle");
    expect(engineCalls).toContain("rm -f ref-run_old");
    expect(engineCalls).toContain("rm -f ref-chat_old");
    expect(engineCalls).not.toContain("ref-chat_4d");
  });

  it("marks destroyed rows (with a timestamp) and keeps their call history", () => {
    const env = scratch();
    lease(env.sqlite, "sbx_hist", "conversation", "stopped", 20 * DAY);
    env.sqlite
      .prepare("insert into conversations (id, created_at, updated_at) values ('c_hist', 0, 0)")
      .run();
    env.sqlite
      .prepare(
        "insert into sandbox_calls (tool_call_id, sandbox_id, conversation_id, tool, via, workdir, at) " +
          "values ('call_h', 'sbx_hist', 'c_hist', 'bash', 'dedicated', '/work/c_hist', 0)",
      )
      .run();

    gc(env, true);
    const row = env.sqlite.prepare("select status, destroyed_at from sandboxes where id = 'sbx_hist'").get() as {
      status: string;
      destroyed_at: number | null;
    };
    expect(row.status).toBe("destroyed");
    expect(row.destroyed_at).not.toBeNull();
    expect(env.sqlite.prepare("select count(*) n from sandbox_calls where sandbox_id = 'sbx_hist'").get()).toEqual({
      n: 1,
    });
  });

  it("is a dry run by default", () => {
    const env = scratch();
    lease(env.sqlite, "run_dry", "machine_run", "running", 4 * DAY);
    const out = gc(env, false);
    expect(out).toContain("would destroy run_dry");
    expect(
      (env.sqlite.prepare("select status from sandboxes where id = 'run_dry'").get() as { status: string }).status,
    ).toBe("running");
  });
});
