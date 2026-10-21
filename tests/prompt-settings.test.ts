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
  PRE_PLACEHOLDER_CHAD_BASE,
  resetToGitDefault,
  restoreVersion,
  SKILL_BODY_MAX_BYTES,
  SKILL_DESCRIPTION_MAX_CHARS,
  type Target,
} from "../db/prompt-settings";

/**
 * 0054 store layer: seeding, the single write primitive's optimistic
 * concurrency, and tombstone (status) semantics. No model, no sandbox,
 * no workflow run — plain sqlite against the per-worker test db
 * (tests/setup.ts).
 */

let seq = 0;
const skillId = () => `pstest-${++seq}-${Date.now().toString(36)}`;
const skillTarget = (id: string): Target => ({ kind: "skill", id });

describe("getTarget / listTargets: seeding", () => {
  it("seeds a section from the current git default on first read, idempotently", () => {
    const target: Target = { kind: "section", key: "base" };
    const first = getTarget(db(), target);
    expect(first).toMatchObject({ version: 1, body: GIT_DEFAULT_SECTIONS.base, editedBy: "git" });
    const second = getTarget(db(), target);
    expect(second?.version).toBe(1);
    expect(second?.body).toBe(first?.body);
  });

  it("seeds base as {{owner}}/{{owner's}} placeholder text, never an owner's literal name", () => {
    const first = getTarget(db(), { kind: "section", key: "base" });
    expect(first?.body).toContain("{{owner}}");
    expect(first?.body).toContain("{{owner's}}");
    expect(first?.body).not.toContain("Chad");
  });

  it("seeds a git-shipped skill (ship) but returns null for an unknown id", () => {
    const ship = getTarget(db(), skillTarget("ship"));
    expect(ship).toMatchObject({ version: 1, origin: "git", editedBy: "git", thread: true });
    expect(ship?.body.startsWith("# Ship")).toBe(true);
    expect(getTarget(db(), skillTarget(skillId()))).toBeNull();
  });

  it("listTargets includes all three sections and every seeded skill, excluding deleted by default", () => {
    const id = skillId();
    expect(
      publishEdit(db(), skillTarget(id), { patch: { body: "# Fresh" }, expectedVersion: 0 }),
    ).toMatchObject({ ok: true, version: 1 });
    const visible = listTargets(db());
    expect(visible.filter((t) => t.kind === "section")).toHaveLength(3);
    expect(visible.some((t) => t.kind === "skill" && t.id === id)).toBe(true);

    expect(
      publishEdit(db(), skillTarget(id), { patch: { status: "deleted" }, expectedVersion: 1 }),
    ).toMatchObject({ ok: true, version: 2 });
    expect(listTargets(db()).some((t) => t.kind === "skill" && t.id === id)).toBe(false);
    expect(listTargets(db(), { includeDeleted: true }).some((t) => t.kind === "skill" && t.id === id)).toBe(true);
  });
});

describe("publishEdit: validation and optimistic concurrency", () => {
  it("rejects a section patch carrying skill-only fields", () => {
    expect(
      publishEdit(db(), { kind: "section", key: "base" }, { patch: { status: "disabled" }, expectedVersion: 1 }),
    ).toMatchObject({ ok: false, code: "invalid" });
  });

  it("rejects an empty patch", () => {
    expect(publishEdit(db(), skillTarget(skillId()), { patch: {}, expectedVersion: 0 })).toMatchObject({
      ok: false,
      code: "invalid",
    });
  });

  it("rejects creating a skill with no body", () => {
    expect(
      publishEdit(db(), skillTarget(skillId()), { patch: { description: "no body" }, expectedVersion: 0 }),
    ).toMatchObject({ ok: false, code: "invalid" });
  });

  it("rejects an oversized section body, skill body, and skill description", () => {
    expect(
      publishEdit(db(), { kind: "section", key: "base" }, {
        patch: { body: "x".repeat(PROMPT_SECTION_MAX_BYTES + 1) },
        expectedVersion: 1,
      }),
    ).toMatchObject({ ok: false, code: "invalid" });
    const id = skillId();
    expect(
      publishEdit(db(), skillTarget(id), { patch: { body: "x".repeat(SKILL_BODY_MAX_BYTES + 1) }, expectedVersion: 0 }),
    ).toMatchObject({ ok: false, code: "invalid" });
    expect(
      publishEdit(db(), skillTarget(id), {
        patch: { body: "# ok", description: "x".repeat(SKILL_DESCRIPTION_MAX_CHARS + 1) },
        expectedVersion: 0,
      }),
    ).toMatchObject({ ok: false, code: "invalid" });
  });

  it("creates a skill at expectedVersion 0, then conflicts on a second create at the same id", () => {
    const id = skillId();
    const created = publishEdit(db(), skillTarget(id), { patch: { body: "# Once" }, expectedVersion: 0 });
    expect(created).toMatchObject({ ok: true, version: 1 });
    const collide = publishEdit(db(), skillTarget(id), { patch: { body: "# Twice" }, expectedVersion: 0 });
    expect(collide.ok).toBe(false);
    if (collide.ok) throw new Error("expected conflict");
    expect(collide.code).toBe("conflict");
  });

  it("conflicts on a stale expectedVersion and reports the current row", () => {
    const id = skillId();
    publishEdit(db(), skillTarget(id), { patch: { body: "# v1" }, expectedVersion: 0 });
    publishEdit(db(), skillTarget(id), { patch: { description: "v2" }, expectedVersion: 1 });
    const stale = publishEdit(db(), skillTarget(id), { patch: { description: "stale" }, expectedVersion: 1 });
    expect(stale.ok).toBe(false);
    if (stale.ok || stale.code !== "conflict") throw new Error("expected conflict");
    expect(stale.current).toMatchObject({ version: 2, description: "v2" });
  });

  it("merges a partial patch over the live row's other fields", () => {
    const id = skillId();
    publishEdit(db(), skillTarget(id), {
      patch: { body: "# Body", description: "desc", thread: true, status: "active" },
      expectedVersion: 0,
    });
    const after = publishEdit(db(), skillTarget(id), { patch: { description: "new desc" }, expectedVersion: 1 });
    expect(after).toMatchObject({ ok: true, version: 2 });
    expect(getTarget(db(), skillTarget(id))).toMatchObject({
      body: "# Body",
      description: "new desc",
      thread: true,
      status: "active",
    });
  });
});

describe("tombstones: disable, delete, and restore are all reversible", () => {
  it("walks disable -> delete -> restore back to the pre-delete active body", () => {
    const id = skillId();
    publishEdit(db(), skillTarget(id), { patch: { body: "# Original", description: "d", thread: true }, expectedVersion: 0 });
    expect(publishEdit(db(), skillTarget(id), { patch: { status: "disabled" }, expectedVersion: 1 })).toMatchObject({
      ok: true,
      version: 2,
    });
    expect(listTargets(db()).find((t) => t.kind === "skill" && t.id === id)?.status).toBe("disabled");

    expect(publishEdit(db(), skillTarget(id), { patch: { status: "deleted" }, expectedVersion: 2 })).toMatchObject({
      ok: true,
      version: 3,
    });
    expect(listTargets(db()).some((t) => t.kind === "skill" && t.id === id)).toBe(false);
    // Tombstoned, never removed: the row and its history are still there.
    expect(getTarget(db(), skillTarget(id))).toMatchObject({ status: "deleted", body: "# Original" });

    // Restore the version from before the delete (v2, disabled) — undoes
    // the delete but not the disable; v1 would undo both.
    expect(restoreVersion(db(), skillTarget(id), { version: 1, expectedVersion: 3 })).toMatchObject({
      ok: true,
      version: 4,
    });
    const restored = getTarget(db(), skillTarget(id));
    expect(restored).toMatchObject({ status: "active", body: "# Original", description: "d", thread: true });
    expect(listTargets(db()).some((t) => t.kind === "skill" && t.id === id)).toBe(true);
  });

  it("restoreVersion rejects a version number that never existed", () => {
    const id = skillId();
    publishEdit(db(), skillTarget(id), { patch: { body: "# One" }, expectedVersion: 0 });
    expect(restoreVersion(db(), skillTarget(id), { version: 7, expectedVersion: 1 })).toMatchObject({
      ok: false,
      code: "invalid",
    });
  });
});

describe("resetToGitDefault", () => {
  it("resets a section back to its current git default", () => {
    const target: Target = { kind: "section", key: "harness_steering" };
    getTarget(db(), target); // seed
    const edited = publishEdit(db(), target, { patch: { body: "custom steering" }, expectedVersion: 1 });
    expect(edited).toMatchObject({ ok: true, version: 2 });
    const reset = resetToGitDefault(db(), target, { expectedVersion: 2 });
    expect(reset).toMatchObject({ ok: true, version: 3 });
    expect(getTarget(db(), target)?.body).toBe(GIT_DEFAULT_SECTIONS.harness_steering);
  });

  it("revives a tombstoned shipped skill to active with its shipped body", () => {
    // "review" is shipped but untouched elsewhere in this file — seed,
    // edit, delete, then reset should both revive and restore it.
    const target = skillTarget("review");
    const shipped = getTarget(db(), target);
    expect(shipped?.origin).toBe("git");
    const deleted = publishEdit(db(), target, { patch: { status: "deleted" }, expectedVersion: shipped!.version });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) throw new Error("expected ok");
    const reset = resetToGitDefault(db(), target, { expectedVersion: deleted.version });
    expect(reset).toMatchObject({ ok: true });
    expect(getTarget(db(), target)).toMatchObject({ status: "active", body: shipped!.body, origin: "git" });
  });

  it("refuses to reset a user-created skill (no-default)", () => {
    const id = skillId();
    publishEdit(db(), skillTarget(id), { patch: { body: "# Mine" }, expectedVersion: 0 });
    const result = resetToGitDefault(db(), skillTarget(id), { expectedVersion: 1 });
    expect(result).toMatchObject({ ok: false, code: "no-default" });
  });
});

describe("listVersions", () => {
  it("returns a target's full history, newest first", () => {
    const id = skillId();
    publishEdit(db(), skillTarget(id), { patch: { body: "# v1" }, expectedVersion: 0 });
    publishEdit(db(), skillTarget(id), { patch: { body: "# v2" }, expectedVersion: 1, note: "second" });
    const versions = listVersions(db(), skillTarget(id));
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[0]).toMatchObject({ body: "# v2", note: "second", editedBy: "user" });
  });
});

describe("applyApprovedChange: the agent-proposal write path", () => {
  it("writes with editedBy agent and still enforces the same conflict rule as publishEdit", () => {
    const id = skillId();
    const created = applyApprovedChange(db(), skillTarget(id), { patch: { body: "# Agent" }, expectedVersion: 0 });
    expect(created).toMatchObject({ ok: true, version: 1 });
    expect(listVersions(db(), skillTarget(id))[0]).toMatchObject({ editedBy: "agent" });
    const stale = applyApprovedChange(db(), skillTarget(id), { patch: { status: "disabled" }, expectedVersion: 0 });
    expect(stale).toMatchObject({ ok: false, code: "conflict" });
  });
});

describe("runtime validation of arbitrary JSON (1): target/patch/expectedVersion/note/version", () => {
  it("getTarget and listVersions treat a malformed target as absent, never throw", () => {
    expect(getTarget(db(), null)).toBeNull();
    expect(getTarget(db(), "base")).toBeNull();
    expect(getTarget(db(), { kind: "section" })).toBeNull();
    expect(getTarget(db(), { kind: "section", key: "nope" })).toBeNull();
    expect(getTarget(db(), { kind: "section", key: "base", extra: 1 })).toBeNull();
    expect(getTarget(db(), { kind: "skill", key: "base" })).toBeNull(); // key, not id
    expect(getTarget(db(), { kind: "bogus", id: "x" })).toBeNull();
    expect(listVersions(db(), null)).toEqual([]);
    expect(listVersions(db(), { kind: "skill" })).toEqual([]);
  });

  it("publishEdit rejects a non-object target, an unknown target field, and a field for the wrong kind", () => {
    const cases: unknown[] = [
      null,
      "base",
      42,
      [],
      { kind: "section", key: "base", extra: "field" },
      { kind: "skill", id: "ok-id", key: "base" }, // key only valid for section
      { kind: "section", id: "nope" }, // id only valid for skill
      { kind: "section", key: "not-a-real-key" },
      { kind: "skill", id: "../traversal" },
      { kind: "skill", id: "UpperCase" },
      { kind: "nonsense" },
    ];
    for (const target of cases) {
      const result = publishEdit(db(), target, { patch: { body: "x" }, expectedVersion: 0 });
      expect(result, JSON.stringify(target)).toMatchObject({ ok: false, code: "invalid" });
    }
  });

  it("publishEdit rejects a non-object patch, an unknown patch field, and wrong-typed patch fields", () => {
    const section: Target = { kind: "section", key: "base" };
    getTarget(db(), section); // seed, version 1
    for (const patch of [null, "x", 42, [], { bogusField: true }]) {
      expect(publishEdit(db(), section, { patch, expectedVersion: 1 })).toMatchObject({ ok: false, code: "invalid" });
    }
    const id = skillId();
    for (const patch of [
      { body: 5 },
      { body: "# ok", description: 5 },
      { body: "# ok", thread: "yes" },
      { body: "# ok", status: "sleeping" },
      { body: "# ok", bogusField: true },
    ]) {
      expect(publishEdit(db(), skillTarget(id), { patch, expectedVersion: 0 })).toMatchObject({ ok: false, code: "invalid" });
    }
  });

  it("publishEdit rejects a non-integer, negative, or out-of-range expectedVersion", () => {
    const target: Target = { kind: "section", key: "base" };
    for (const expectedVersion of [1.5, -1, "1", null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2, {}]) {
      expect(publishEdit(db(), target, { patch: { body: "x" }, expectedVersion })).toMatchObject({
        ok: false,
        code: "invalid",
      });
    }
  });

  it("publishEdit rejects a non-string or oversized note", () => {
    const target: Target = { kind: "section", key: "base" };
    getTarget(db(), target);
    for (const note of [42, {}, []]) {
      expect(publishEdit(db(), target, { patch: { body: "x" }, expectedVersion: 1, note })).toMatchObject({
        ok: false,
        code: "invalid",
      });
    }
    expect(
      publishEdit(db(), target, { patch: { body: "x" }, expectedVersion: 1, note: "y".repeat(2001) }),
    ).toMatchObject({ ok: false, code: "invalid" });
  });

  it("restoreVersion rejects a non-positive-integer version and a malformed target", () => {
    const id = skillId();
    publishEdit(db(), skillTarget(id), { patch: { body: "# One" }, expectedVersion: 0 });
    for (const version of [0, -1, 1.5, "1", null, undefined]) {
      expect(restoreVersion(db(), skillTarget(id), { version, expectedVersion: 1 })).toMatchObject({
        ok: false,
        code: "invalid",
      });
    }
    expect(restoreVersion(db(), { kind: "skill", id: "UpperCase" }, { version: 1, expectedVersion: 0 })).toMatchObject({
      ok: false,
      code: "invalid",
    });
  });

  it("resetToGitDefault rejects a malformed expectedVersion and a malformed target", () => {
    const target: Target = { kind: "section", key: "base" };
    getTarget(db(), target);
    expect(resetToGitDefault(db(), target, { expectedVersion: "1" })).toMatchObject({ ok: false, code: "invalid" });
    expect(resetToGitDefault(db(), { kind: "section", key: "nope" }, { expectedVersion: 1 })).toMatchObject({
      ok: false,
      code: "invalid",
    });
  });
});

describe("seeding is transactional (2): row + history never drift, even seeded mid-write", () => {
  it("a never-before-read git-shipped skill seeds AND applies the edit in one writeVersion call", () => {
    // No prior getTarget — writeVersion's own seeding (inside its
    // transaction) must create v1 (the git seed) before applying v2
    // (this edit), atomically, in a single call.
    const target = skillTarget("ticket");
    const result = publishEdit(db(), target, { patch: { description: "edited on first touch" }, expectedVersion: 1 });
    expect(result).toMatchObject({ ok: true, version: 2 });
    const history = listVersions(db(), target);
    expect(history.map((v) => v.version)).toEqual([2, 1]);
    expect(history[1]).toMatchObject({ editedBy: "git", version: 1 });
    expect(history[0]).toMatchObject({ editedBy: "user", version: 2, description: "edited on first touch" });
  });

  it("seeding a section or a skill twice never duplicates (or drifts) the version-1 history row", () => {
    const section: Target = { kind: "section", key: "host_routing" };
    getTarget(db(), section);
    getTarget(db(), section);
    expect(listVersions(db(), section)).toHaveLength(1);

    const skill = skillTarget("ship");
    getTarget(db(), skill);
    getTarget(db(), skill);
    getTarget(db(), skill);
    const history = listVersions(db(), skill);
    expect(history.filter((v) => v.version === 1)).toHaveLength(1);
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
});
