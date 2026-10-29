import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { db, openDb, type Db } from "../db";
import { promptSections, promptSectionVersions } from "../db/schema";
import { GIT_DEFAULT_SECTIONS } from "../workflows/chat/instructions";
import {
  applyApprovedChange,
  getTarget,
  listTargets,
  listVersions,
  publishEdit,
  PROMPT_SECTION_MAX_BYTES,
  PRE_0055_BASE_PLACEHOLDER,
  PRE_GIT_LINKS_BASE,
  PRE_0059_BASE,
  PRE_0064_BASE,
  PRE_0064_PR3_BASE,
  PRE_0081_BASE,
  PRE_0088_BASE,
  PRE_PLACEHOLDER_CHAD_BASE,
  resetToGitDefault,
  restoreVersion,
  type Target,
} from "../db/prompt-settings";

/**
 * 0054 store layer (sections only since 0088 moved skills to the S3
 * catalog): seeding, the single write primitive's optimistic
 * concurrency, and restore/reset. No model, no sandbox, no workflow run
 * — plain sqlite against the per-worker test db (tests/setup.ts).
 */

const base: Target = { kind: "section", key: "base" };
const steering: Target = { kind: "section", key: "harness_steering" };

describe("getTarget / listTargets: seeding", () => {
  it("seeds a section from the current git default on first read, idempotently", () => {
    const first = getTarget(db(), base);
    expect(first).toMatchObject({ version: 1, body: GIT_DEFAULT_SECTIONS.base, editedBy: "git" });
    const second = getTarget(db(), base);
    expect(second?.version).toBe(1);
    expect(second?.body).toBe(first?.body);
  });

  it("seeds base as {{owner}}/{{owner's}} placeholder text, never an owner's literal name", () => {
    const first = getTarget(db(), base);
    expect(first?.body).toContain("{{owner}}");
    expect(first?.body).toContain("{{owner's}}");
    expect(first?.body).not.toContain("Chad");
  });

  it("listTargets lists exactly the three sections", () => {
    const listed = listTargets(db());
    expect(listed.map((t) => t.key)).toEqual(["base", "harness_steering", "host_routing"]);
    expect(listed.every((t) => t.kind === "section")).toBe(true);
  });

  it("a skill target is not a target anymore (0088)", () => {
    expect(getTarget(db(), { kind: "skill", id: "ship" })).toBeNull();
    expect(publishEdit(db(), { kind: "skill", id: "ship" }, { patch: { body: "x" }, expectedVersion: 0 })).toMatchObject({
      ok: false,
      code: "invalid",
    });
  });
});

describe("publishEdit: validation and optimistic concurrency", () => {
  it("rejects a section patch carrying non-body fields", () => {
    expect(publishEdit(db(), base, { patch: { status: "disabled" }, expectedVersion: 1 })).toMatchObject({
      ok: false,
      code: "invalid",
    });
  });

  it("rejects an empty patch", () => {
    expect(publishEdit(db(), base, { patch: {}, expectedVersion: 1 })).toMatchObject({ ok: false, code: "invalid" });
  });

  it("rejects an oversized section body", () => {
    expect(
      publishEdit(db(), base, { patch: { body: "x".repeat(PROMPT_SECTION_MAX_BYTES + 1) }, expectedVersion: 1 }),
    ).toMatchObject({ ok: false, code: "invalid" });
  });

  it("conflicts on a stale expectedVersion and reports the current row", () => {
    const target: Target = { kind: "section", key: "host_routing" };
    getTarget(db(), target);
    expect(publishEdit(db(), target, { patch: { body: "v2" }, expectedVersion: 1 })).toMatchObject({ ok: true, version: 2 });
    const stale = publishEdit(db(), target, { patch: { body: "stale" }, expectedVersion: 1 });
    expect(stale.ok).toBe(false);
    if (stale.ok || stale.code !== "conflict") throw new Error("expected conflict");
    expect(stale.current).toMatchObject({ version: 2, body: "v2" });
  });
});

describe("restoreVersion", () => {
  it("writes a historic body forward as a new version", () => {
    const target: Target = { kind: "section", key: "host_routing" };
    const v1 = getTarget(db(), target)!;
    const edited = publishEdit(db(), target, { patch: { body: "edited" }, expectedVersion: v1.version });
    if (!edited.ok) throw new Error("expected ok");
    expect(restoreVersion(db(), target, { version: v1.version, expectedVersion: edited.version })).toMatchObject({
      ok: true,
      version: edited.version + 1,
    });
    expect(getTarget(db(), target)?.body).toBe(v1.body);
  });

  it("rejects a version number that never existed", () => {
    getTarget(db(), base);
    expect(restoreVersion(db(), base, { version: 999, expectedVersion: 1 })).toMatchObject({ ok: false, code: "invalid" });
  });
});

describe("resetToGitDefault", () => {
  it("resets a section back to its current git default", () => {
    getTarget(db(), steering); // seed
    const edited = publishEdit(db(), steering, { patch: { body: "custom steering" }, expectedVersion: 1 });
    expect(edited).toMatchObject({ ok: true, version: 2 });
    const reset = resetToGitDefault(db(), steering, { expectedVersion: 2 });
    expect(reset).toMatchObject({ ok: true, version: 3 });
    expect(getTarget(db(), steering)?.body).toBe(GIT_DEFAULT_SECTIONS.harness_steering);
  });
});

describe("listVersions", () => {
  it("returns a section's full history, newest first", () => {
    const target: Target = { kind: "section", key: "host_routing" };
    const current = getTarget(db(), target)!;
    publishEdit(db(), target, { patch: { body: "history-next" }, expectedVersion: current.version, note: "history" });
    const versions = listVersions(db(), target);
    expect(versions[0]).toMatchObject({ body: "history-next", note: "history", editedBy: "user" });
    expect(versions[0]!.version).toBeGreaterThan(versions[1]!.version);
  });
});

describe("applyApprovedChange: the agent-proposal write path", () => {
  it("writes with editedBy agent and still enforces the same conflict rule as publishEdit", () => {
    const target: Target = { kind: "section", key: "host_routing" };
    const current = getTarget(db(), target)!;
    const applied = applyApprovedChange(db(), target, { patch: { body: "# Agent" }, expectedVersion: current.version });
    expect(applied).toMatchObject({ ok: true });
    expect(listVersions(db(), target)[0]).toMatchObject({ editedBy: "agent" });
    const stale = applyApprovedChange(db(), target, { patch: { body: "stale" }, expectedVersion: current.version });
    expect(stale).toMatchObject({ ok: false, code: "conflict" });
  });
});

describe("runtime validation of arbitrary JSON: target/patch/expectedVersion/note/version", () => {
  it("getTarget and listVersions treat a malformed target as absent, never throw", () => {
    expect(getTarget(db(), null)).toBeNull();
    expect(getTarget(db(), "base")).toBeNull();
    expect(getTarget(db(), { kind: "section" })).toBeNull();
    expect(getTarget(db(), { kind: "section", key: "nope" })).toBeNull();
    expect(getTarget(db(), { kind: "section", key: "base", extra: 1 })).toBeNull();
    expect(getTarget(db(), { kind: "bogus", key: "base" })).toBeNull();
    expect(listVersions(db(), null)).toEqual([]);
    expect(listVersions(db(), { kind: "skill", id: "x" })).toEqual([]);
  });

  it("publishEdit rejects a non-object target, an unknown target field, and an unknown kind", () => {
    const cases: unknown[] = [
      null,
      "base",
      42,
      [],
      { kind: "section", key: "base", extra: "field" },
      { kind: "section", id: "nope" },
      { kind: "section", key: "not-a-real-key" },
      { kind: "skill", id: "ok-id" },
      { kind: "nonsense" },
    ];
    for (const target of cases) {
      const result = publishEdit(db(), target, { patch: { body: "x" }, expectedVersion: 0 });
      expect(result, JSON.stringify(target)).toMatchObject({ ok: false, code: "invalid" });
    }
  });

  it("publishEdit rejects a non-object patch, an unknown patch field, and a wrong-typed body", () => {
    getTarget(db(), base); // seed, version 1
    for (const patch of [null, "x", 42, [], { bogusField: true }, { body: 5 }, { body: "ok", bogusField: true }]) {
      expect(publishEdit(db(), base, { patch, expectedVersion: 1 })).toMatchObject({ ok: false, code: "invalid" });
    }
  });

  it("publishEdit rejects a non-integer, negative, or out-of-range expectedVersion", () => {
    for (const expectedVersion of [1.5, -1, "1", null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2, {}]) {
      expect(publishEdit(db(), base, { patch: { body: "x" }, expectedVersion })).toMatchObject({
        ok: false,
        code: "invalid",
      });
    }
  });

  it("publishEdit rejects a non-string or oversized note", () => {
    getTarget(db(), base);
    for (const note of [42, {}, []]) {
      expect(publishEdit(db(), base, { patch: { body: "x" }, expectedVersion: 1, note })).toMatchObject({
        ok: false,
        code: "invalid",
      });
    }
    expect(
      publishEdit(db(), base, { patch: { body: "x" }, expectedVersion: 1, note: "y".repeat(2001) }),
    ).toMatchObject({ ok: false, code: "invalid" });
  });

  it("restoreVersion rejects a non-positive-integer version and a malformed target", () => {
    getTarget(db(), base);
    for (const version of [0, -1, 1.5, "1", null, undefined]) {
      expect(restoreVersion(db(), base, { version, expectedVersion: 1 })).toMatchObject({ ok: false, code: "invalid" });
    }
    expect(restoreVersion(db(), { kind: "skill", id: "x" }, { version: 1, expectedVersion: 0 })).toMatchObject({
      ok: false,
      code: "invalid",
    });
  });

  it("resetToGitDefault rejects a malformed expectedVersion and a malformed target", () => {
    getTarget(db(), base);
    expect(resetToGitDefault(db(), base, { expectedVersion: "1" })).toMatchObject({ ok: false, code: "invalid" });
    expect(resetToGitDefault(db(), { kind: "section", key: "nope" }, { expectedVersion: 1 })).toMatchObject({
      ok: false,
      code: "invalid",
    });
  });
});

describe("seeding is transactional: row + history never drift, even seeded mid-write", () => {
  it("seeding a section twice never duplicates the version-1 history row", () => {
    const section: Target = { kind: "section", key: "base" };
    getTarget(db(), section);
    getTarget(db(), section);
    expect(listVersions(db(), section).filter((v) => v.version === 1)).toHaveLength(1);
  });
});

/**
 * Owner-placeholder repair: a `base` row already seeded (pre-fix) with the literal
 * "Chad" default gets upgraded to the placeholder default on next read.
 * This mutates the singleton `base` row directly, so it runs against
 * its own freshly migrated scratch db — never the shared `db()` every
 * other test in this file reads/writes.
 */
describe("repairing a stale pre-placeholder base row", () => {
  function freshDb(): Db {
    const dir = mkdtempSync(path.join(tmpdir(), "sweatshop-prompt-repair-"));
    const dbPath = path.join(dir, "t.db");
    const sqlite = new Database(dbPath);
    sqlite.pragma("foreign_keys = OFF");
    migrate(drizzle(sqlite), { migrationsFolder: path.join(process.cwd(), "drizzle") });
    sqlite.close();
    return openDb(dbPath);
  }

  function seedBaseDirectly(conn: Db, body: string, editedBy: "git" | "user" | "agent") {
    const now = Date.now();
    conn.insert(promptSections).values({ key: "base", body, version: 1, editedBy, note: null, createdAt: now, updatedAt: now }).run();
    conn.insert(promptSectionVersions).values({ key: "base", version: 1, body, editedBy, note: null, createdAt: now }).run();
  }

  it("upgrades an old git-seeded Chad default to the new placeholder default, as a new git version", () => {
    const conn = freshDb();
    seedBaseDirectly(conn, PRE_PLACEHOLDER_CHAD_BASE, "git");

    const repaired = getTarget(conn, { kind: "section", key: "base" });
    expect(repaired).toMatchObject({ version: 2, body: GIT_DEFAULT_SECTIONS.base, editedBy: "git", note: "owner placeholders" });

    const history = listVersions(conn, { kind: "section", key: "base" });
    expect(history.map((v) => v.version)).toEqual([2, 1]);
  });

  it("is idempotent — a second read does not bump the version again", () => {
    const conn = freshDb();
    seedBaseDirectly(conn, PRE_PLACEHOLDER_CHAD_BASE, "git");
    getTarget(conn, { kind: "section", key: "base" });
    const second = getTarget(conn, { kind: "section", key: "base" });
    expect(second?.version).toBe(2);
  });

  it("never rewrites a user- or agent-edited row, even one that happens to match the old text byte-for-byte", () => {
    const conn = freshDb();
    seedBaseDirectly(conn, PRE_PLACEHOLDER_CHAD_BASE, "user");
    const untouched = getTarget(conn, { kind: "section", key: "base" });
    expect(untouched).toMatchObject({ version: 1, body: PRE_PLACEHOLDER_CHAD_BASE, editedBy: "user" });
  });

  it("leaves an already-placeholder git row alone", () => {
    const conn = freshDb();
    seedBaseDirectly(conn, GIT_DEFAULT_SECTIONS.base, "git");
    const same = getTarget(conn, { kind: "section", key: "base" });
    expect(same).toMatchObject({ version: 1, body: GIT_DEFAULT_SECTIONS.base, editedBy: "git" });
  });

  it("0055: a row still at the pre-ticket-mode placeholder default also upgrades straight to the current default", () => {
    const conn = freshDb();
    seedBaseDirectly(conn, PRE_0055_BASE_PLACEHOLDER, "git");
    const repaired = getTarget(conn, { kind: "section", key: "base" });
    expect(repaired).toMatchObject({ version: 2, body: GIT_DEFAULT_SECTIONS.base, editedBy: "git", note: "0055 ticket mode" });
  });

  it("a row still at the pre-git-links default upgrades to the current default", () => {
    const conn = freshDb();
    seedBaseDirectly(conn, PRE_GIT_LINKS_BASE, "git");
    const repaired = getTarget(conn, { kind: "section", key: "base" });
    expect(repaired).toMatchObject({ version: 2, body: GIT_DEFAULT_SECTIONS.base, editedBy: "git", note: "git-host links" });
    expect(GIT_DEFAULT_SECTIONS.base).toContain("github.com/<owner>/<repo>/commit/<sha>");
  });

  it("0059: a git row still at the pre-thread-status base upgrades to the current default", () => {
    const conn = freshDb();
    seedBaseDirectly(conn, PRE_0059_BASE, "git");
    const repaired = getTarget(conn, { kind: "section", key: "base" });
    expect(repaired).toMatchObject({ version: 2, body: GIT_DEFAULT_SECTIONS.base, editedBy: "git", note: "0059 thread status" });
    expect(repaired?.body).toContain("update_outline");
    expect(repaired?.body).not.toContain("enter_mode");
  });

  it("0064: a git row still at the pre-outline base upgrades to the current default", () => {
    const conn = freshDb();
    seedBaseDirectly(conn, PRE_0064_BASE, "git");
    const repaired = getTarget(conn, { kind: "section", key: "base" });
    expect(repaired).toMatchObject({ version: 2, body: GIT_DEFAULT_SECTIONS.base, editedBy: "git", note: "0064 outline" });
    expect(repaired?.body).toContain("update_outline");
    expect(repaired?.body).not.toContain("update_status");
    expect(repaired?.body).not.toContain("present_plan");
    expect(repaired?.body).toContain("Top-level runners");
  });
  it("0064 PR3: a git row at main's 0064 PR1–2 base (still naming present_plan) upgrades", () => {
    const conn = freshDb();
    seedBaseDirectly(conn, PRE_0064_PR3_BASE, "git");
    const repaired = getTarget(conn, { kind: "section", key: "base" });
    expect(repaired).toMatchObject({ version: 2, body: GIT_DEFAULT_SECTIONS.base, editedBy: "git", note: "0064 outline (modes and PLAN.md removed)" });
    expect(repaired?.body).not.toContain("present_plan");
    expect(repaired?.body).not.toContain("suggestedSteps");
    expect(PRE_0064_PR3_BASE).toContain("present_plan");
  });

  it("0064 PR3: an owner-edited copy of that base is never upgraded", () => {
    const conn = freshDb();
    seedBaseDirectly(conn, PRE_0064_PR3_BASE, "user");
    expect(getTarget(conn, { kind: "section", key: "base" })).toMatchObject({ version: 1, body: PRE_0064_PR3_BASE, editedBy: "user" });
  });

  it("0081: a git row at the pre-structured-questions base upgrades to the current default", () => {
    const conn = freshDb();
    seedBaseDirectly(conn, PRE_0081_BASE, "git");
    const repaired = getTarget(conn, { kind: "section", key: "base" });
    expect(repaired).toMatchObject({ version: 2, body: GIT_DEFAULT_SECTIONS.base, editedBy: "git", note: "0081 structured questions" });
    expect(repaired?.body).toContain("put your reasoning in context");
    expect(PRE_0081_BASE).not.toContain("put your reasoning in context");
  });

  it("0088: a git row at the pre-skills-catalog base upgrades; an owner-edited copy never does", () => {
    const conn = freshDb();
    seedBaseDirectly(conn, PRE_0088_BASE, "git");
    const repaired = getTarget(conn, { kind: "section", key: "base" });
    expect(repaired).toMatchObject({ version: 2, body: GIT_DEFAULT_SECTIONS.base, editedBy: "git", note: "0088 skills catalog" });
    expect(PRE_0088_BASE).toContain('start_thread with the "review" skill');
    expect(repaired?.body).not.toContain('"review" skill');

    const edited = freshDb();
    seedBaseDirectly(edited, PRE_0088_BASE, "user");
    expect(getTarget(edited, { kind: "section", key: "base" })).toMatchObject({ version: 1, body: PRE_0088_BASE, editedBy: "user" });
  });

  it("0081: an owner-edited copy of that base is never upgraded", () => {
    const conn = freshDb();
    seedBaseDirectly(conn, PRE_0081_BASE, "user");
    expect(getTarget(conn, { kind: "section", key: "base" })).toMatchObject({ version: 1, body: PRE_0081_BASE, editedBy: "user" });
  });
});
