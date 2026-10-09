import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { parseDefinition } from "../lib/machines/definition";

/**
 * 0023: the catalog IS the seeds — every seed parses through
 * parseDefinition, the approved shapes are structurally present, and
 * `seed.mjs --replace` swaps the catalog rows without touching
 * anything else.
 */

const seedDir = path.join(process.cwd(), "lib", "machines", "seeds");
const seeds = readdirSync(seedDir)
  .filter((f) => f.endsWith(".json"))
  .map((file) => JSON.parse(readFileSync(path.join(seedDir, file), "utf8")) as { id: string; definition: unknown });
const byId = new Map(seeds.map((s) => [s.id, s]));

/** Parsed-or-throw: the seed catalog must be valid, full stop. */
const defOf = (id: string) => {
  const parsed = parseDefinition(byId.get(id)!.definition);
  if (!parsed.ok) throw new Error(`${id}: ${parsed.errors.join("; ")}`);
  return parsed.definition;
};

describe("0023: the seed catalog", () => {
  it("is exactly the four approved machines, all valid definitions", () => {
    expect([...byId.keys()].sort()).toEqual(["bugfix", "review", "think", "ticket"]);
    for (const seed of seeds) {
      expect(parseDefinition(seed.definition).ok, seed.id).toBe(true);
    }
  });

  it("ticket: revise edge on the gate, flash-pinned pi stages, branch contract in the plan", () => {
    const def = defOf("ticket");
    const approve = def.stages.approve!;
    expect(approve.kind).toBe("human");
    expect(approve.next.map((t) => t.to).sort()).toEqual(["end", "implement", "plan"]);
    for (const id of ["plan", "verify"]) {
      const stage = def.stages[id]!;
      expect(stage.kind).toBe("harness");
      if (stage.kind === "harness") {
        expect(stage.route).toEqual({ harness: "pi", provider: "glm", model: "glm-5.3-flash" });
      }
    }
    expect(def.stages.plan!.instructions).toContain("BRANCH:");
    expect(def.stages.verify!.instructions).toContain("# Project");
    // 0034 A: verify declares the PR, the human gate approves it, and a
    // deterministic publish stage pushes + opens it.
    expect(def.stages.verify!.instructions).toContain("propose_pr");
    const prApprove = def.stages["pr-approve"]!;
    expect(prApprove.kind).toBe("human");
    expect(prApprove.next.map((t) => t.to).sort()).toEqual(["end", "implement", "publish"]);
    expect(def.stages.publish!.kind).toBe("publish");
  });

  it("bugfix: reproduce can end the run, the gate sits after diagnosis, claude fixes", () => {
    const def = defOf("bugfix");
    const reproduce = def.stages.reproduce!;
    expect(reproduce.kind).toBe("harness");
    expect(reproduce.next.map((t) => t.to).sort()).toEqual(["diagnose", "end"]);
    expect(def.start).toBe("reproduce");
    // diagnose → approve → fix (the gate is between diagnosis and fix)
    expect(def.stages.diagnose!.next.map((t) => t.to)).toEqual(["approve"]);
    expect(def.stages.approve!.next.map((t) => t.to).sort()).toEqual(["end", "fix"]);
    expect(def.stages.fix!.kind).toBe("harness");
    if (def.stages.fix!.kind === "harness") expect(def.stages.fix!.harness).toBe("claude");
    expect(def.stages.verify!.maxVisits).toBe(3);
  });

  it("review: one fresh-context agent stage that ends the run, unpinned route", () => {
    const def = defOf("review");
    expect(Object.keys(def.stages)).toEqual(["review"]);
    const stage = def.stages.review!;
    expect(stage.kind).toBe("agent");
    if (stage.kind === "agent") expect(stage.route).toBeUndefined();
    expect(stage.next).toEqual([]);
    expect(stage.instructions).toContain("PASS");
  });
});

// --- seed.mjs --replace ------------------------------------------------------

const dir = mkdtempSync(path.join(tmpdir(), "sweatshop-seed-test-"));
const dbPath = path.join(dir, "seed.db");
const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = OFF");
migrate(drizzle(sqlite), { migrationsFolder: path.join(process.cwd(), "drizzle") });
sqlite.pragma("foreign_keys = ON");
sqlite.close();
afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(dbPath + suffix, { force: true });
    } catch {
      /* temp dir cleanup */
    }
  }
});

const runSeed = (...args: string[]) =>
  execFileSync(process.execPath, [path.join(process.cwd(), "scripts", "seed.mjs"), ...args], {
    env: { ...process.env, SWEATSHOP_DB: dbPath },
    stdio: "pipe",
  })
    .toString()
    .trim();

describe("0023: seed.mjs --replace", () => {
  it("is insert-only without the flag, replaces the catalog with it", () => {
    runSeed();
    const check = new Database(dbPath);
    const machine = (id: string) => check.prepare("select version, definition from machines where id = ?").get(id) as { version: number; definition: string } | undefined;
    expect(machine("ticket")).toBeTruthy();
    expect(machine("bugfix")).toBeTruthy();
    expect(machine("review")).toBeTruthy();

    // an app edit survives the insert-only default run
    check.prepare("update machines set version = 7, definition = '{\"workspace\":\"none\"}' where id = 'think'").run();
    runSeed();
    expect(machine("think")).toMatchObject({ version: 7 });

    // --replace resets the catalog rows to the seed files
    const out = runSeed("--replace");
    expect(out).toContain("replaced: machines");
    expect(machine("think")).toMatchObject({ version: 1 });
    expect(machine("ticket")).toMatchObject({ version: 1 });
    const ticket = JSON.parse(machine("ticket")!.definition);
    expect(ticket.stages.approve.next.length).toBe(3);

    // idempotent: a second --replace is the same state
    runSeed("--replace");
    expect(machine("ticket")).toMatchObject({ version: 1 });
    check.close();
  });
});
