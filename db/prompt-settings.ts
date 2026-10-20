import { and, desc, eq } from "drizzle-orm";
import { listGitSkillIds, readGitSkillDefault, SKILL_ID } from "../lib/skill-files";
import { GIT_DEFAULT_SECTIONS } from "../workflows/chat/instructions";
import type { Db } from "./index";
import { promptSectionVersions, promptSections, skillVersions, skills } from "./schema";

/**
 * 0054: the editable-agent-settings store. Every write — a UI save, a
 * restore, a reset, or an approved agent proposal, for ANY field
 * including a skill's status — goes through one transactional
 * primitive (`writeVersion`) that bumps a per-row version counter and
 * appends a history row in the same transaction. That is what makes
 * every change reversible: if it's a version, `restoreVersion` can get
 * back to it — including a disable or a delete (a tombstone status,
 * never a real DELETE).
 *
 * Integration hardening (hot on this feature's heels): callers outside
 * this file are deserialized JSON wearing a TypeScript cast — the API
 * route casts `request.json()`'s fields `as Patch`/`as Target` so the
 * compiler stays quiet, but nothing stops a malformed body from
 * reaching here at runtime. So every public write/read below treats
 * `target`, `patch`, `expectedVersion`, `note`, and `version` as
 * `unknown` and runs them through a parser that returns `{ok:false,
 * code:"invalid", issues}` on anything malformed — unknown keys
 * included — never a thrown exception. The API route no longer needs
 * (or has) its own casts; this is "the store owns all shared
 * validation" made literally true.
 *
 * `getTarget`/`listTargets` are plain SYNCHRONOUS functions (seeding
 * uses `lib/skill-files.ts`'s synchronous fs reads, not fs/promises) —
 * callers compare their result immediately without awaiting.
 */

export type SectionKey = "base" | "harness_steering" | "host_routing";
export const SECTION_KEYS: readonly SectionKey[] = ["base", "harness_steering", "host_routing"];
export type SkillStatus = "active" | "disabled" | "deleted";
const SKILL_STATUSES: readonly SkillStatus[] = ["active", "disabled", "deleted"];

export type Target = { kind: "section"; key: SectionKey } | { kind: "skill"; id: string };

/** A skill patch may set any subset of its versioned fields; a section
 *  patch only ever has `body` — description/thread/status on a section
 *  patch is a validation error, not silently ignored. */
export interface Patch {
  body?: string;
  description?: string;
  thread?: boolean;
  status?: SkillStatus;
}

export interface TargetRow {
  version: number;
  body: string;
  editedBy: "git" | "user" | "agent";
  note: string | null;
  createdAt: number;
  updatedAt: number;
  /** skill-only. */
  origin?: "git" | "user";
  description?: string;
  thread?: boolean;
  status?: SkillStatus;
}

export const PROMPT_SECTION_MAX_BYTES = 32 * 1024;
export const SKILL_BODY_MAX_BYTES = 64 * 1024;
export const SKILL_DESCRIPTION_MAX_CHARS = 500;
/** Defensive cap on a write's `note` — no product requirement picked a
 *  number, so this matches the generous end of other free-text caps in
 *  the codebase (e.g. ask_chad's `question`). */
export const NOTE_MAX_CHARS = 2000;

export type Fail = { ok: false; code: "invalid"; issues: string[] };

export type WriteResult =
  | { ok: true; version: number }
  | { ok: false; code: "conflict"; current: TargetRow | null }
  | Fail
  | { ok: false; code: "no-default"; message: string };

function invalid(...issues: string[]): Fail {
  return { ok: false, code: "invalid", issues };
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

// --- runtime parsing of untrusted input --------------------------------------
// Every one of these takes `unknown` (not the "shape" type) on purpose:
// that shape type is exactly what a caller casts deserialized JSON to
// before it gets here, so treating it as trustworthy is the bug.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseTarget(value: unknown): { ok: true; target: Target } | Fail {
  if (!isPlainObject(value)) return invalid("target must be an object");
  const extraBase = Object.keys(value).filter((k) => k !== "kind" && k !== "key" && k !== "id");
  if (extraBase.length > 0) return invalid(`unknown target field(s): ${extraBase.join(", ")}`);
  if (value.kind === "section") {
    if ("id" in value) return invalid('target field "id" is not valid for kind "section"');
    if (typeof value.key !== "string" || !(SECTION_KEYS as readonly string[]).includes(value.key)) {
      return invalid(`target.key must be one of ${SECTION_KEYS.join(", ")}`);
    }
    return { ok: true, target: { kind: "section", key: value.key as SectionKey } };
  }
  if (value.kind === "skill") {
    if ("key" in value) return invalid('target field "key" is not valid for kind "skill"');
    if (typeof value.id !== "string" || !SKILL_ID.test(value.id)) {
      return invalid("target.id must match ^[a-z][a-z0-9-]{0,40}$");
    }
    return { ok: true, target: { kind: "skill", id: value.id } };
  }
  return invalid('target.kind must be "section" or "skill"');
}

function parseExpectedVersion(value: unknown): { ok: true; version: number } | Fail {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalid("expectedVersion must be a non-negative integer");
  }
  return { ok: true, version: value };
}

function parsePositiveInt(value: unknown, field: string): { ok: true; value: number } | Fail {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return invalid(`${field} must be a positive integer`);
  }
  return { ok: true, value };
}

function parseNote(value: unknown): { ok: true; note?: string } | Fail {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string") return invalid("note must be a string");
  if (value.length > NOTE_MAX_CHARS) return invalid(`note exceeds ${NOTE_MAX_CHARS} characters`);
  return { ok: true, note: value };
}

/** Patch field shapes, BEFORE the business-rule checks in
 *  `checkPatchRules` (caps, section-only-body, create-requires-body):
 *  unknown keys and wrong field types are rejected here so a malformed
 *  JSON body never reaches a bare property read. */
function parsePatch(value: unknown, kind: "section" | "skill"): { ok: true; patch: Patch } | Fail {
  if (!isPlainObject(value)) return invalid("patch must be an object");
  const allowed = kind === "section" ? ["body"] : ["body", "description", "thread", "status"];
  const extra = Object.keys(value).filter((k) => !allowed.includes(k));
  if (extra.length > 0) return invalid(`unknown patch field(s): ${extra.join(", ")}`);

  const issues: string[] = [];
  const patch: Patch = {};
  if (value.body !== undefined) {
    if (typeof value.body !== "string") issues.push("patch.body must be a string");
    else patch.body = value.body;
  }
  if (kind === "skill") {
    if (value.description !== undefined) {
      if (typeof value.description !== "string") issues.push("patch.description must be a string");
      else patch.description = value.description;
    }
    if (value.thread !== undefined) {
      if (typeof value.thread !== "boolean") issues.push("patch.thread must be a boolean");
      else patch.thread = value.thread;
    }
    if (value.status !== undefined) {
      if (typeof value.status !== "string" || !(SKILL_STATUSES as readonly string[]).includes(value.status)) {
        issues.push("patch.status must be active, disabled, or deleted");
      } else patch.status = value.status as SkillStatus;
    }
  }
  if (issues.length > 0) return { ok: false, code: "invalid", issues };
  return { ok: true, patch };
}

/** Pick<Db, ...> only — what a transaction callback's `tx` and the
 *  top-level `Db` both satisfy, so seeding/read helpers (including
 *  seeding's OWN nested transaction) work identically inside or
 *  outside an outer transaction (same pattern as db/plans.ts's and
 *  db/organize.ts's own `Conn`; drizzle's better-sqlite3 driver opens
 *  a SAVEPOINT when `.transaction()` is called on an object that's
 *  already inside one). */
type Conn = Pick<Db, "select" | "insert" | "update" | "transaction">;

// --- reads ------------------------------------------------------------------

function sectionRow(db: Conn, key: SectionKey): TargetRow | null {
  const row = db.select().from(promptSections).where(eq(promptSections.key, key)).get();
  if (!row) return null;
  return {
    version: row.version,
    body: row.body,
    editedBy: row.editedBy as TargetRow["editedBy"],
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function skillRow(db: Conn, id: string): TargetRow | null {
  const row = db.select().from(skills).where(eq(skills.id, id)).get();
  if (!row) return null;
  return {
    version: row.version,
    body: row.body,
    editedBy: row.editedBy as TargetRow["editedBy"],
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    origin: row.origin as TargetRow["origin"],
    description: row.description,
    thread: row.thread,
    status: row.status as SkillStatus,
  };
}

/** Seed a section's row + version-1 history from the current git
 *  default, if it doesn't exist yet — the two inserts share ONE
 *  transaction (a nested SAVEPOINT when called from inside
 *  `writeVersion`'s own transaction), so a crash or a concurrent writer
 *  between them can never leave a live row with no matching history
 *  row (or vice versa). `ON CONFLICT DO NOTHING` on both inserts makes
 *  a second, concurrent seed attempt at the same key a clean no-op —
 *  never a duplicate, never drift. */
function seedSection(db: Conn, key: SectionKey): void {
  if (db.select({ key: promptSections.key }).from(promptSections).where(eq(promptSections.key, key)).get()) return;
  const now = Date.now();
  const body = GIT_DEFAULT_SECTIONS[key];
  db.transaction((tx) => {
    tx.insert(promptSections)
      .values({ key, body, version: 1, editedBy: "git", note: null, createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .run();
    tx.insert(promptSectionVersions)
      .values({ key, version: 1, body, editedBy: "git", note: null, createdAt: now })
      .onConflictDoNothing()
      .run();
  });
}

/** Seed a skill's row + version-1 history from its git default, if it
 *  exists as `skills/<id>/SKILL.md` and has no row yet — same
 *  single-transaction guarantee as `seedSection`. A no-op for an id
 *  that already has a row, or isn't git-shipped at all. */
function seedSkillIfGitShipped(db: Conn, id: string): void {
  if (db.select({ id: skills.id }).from(skills).where(eq(skills.id, id)).get()) return;
  const def = readGitSkillDefault(id);
  if (!def) return;
  const now = Date.now();
  db.transaction((tx) => {
    tx.insert(skills)
      .values({
        id,
        origin: "git",
        description: def.description,
        thread: def.thread,
        status: "active",
        body: def.body,
        version: 1,
        editedBy: "git",
        note: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
    tx.insert(skillVersions)
      .values({
        skillId: id,
        version: 1,
        description: def.description,
        thread: def.thread,
        status: "active",
        body: def.body,
        editedBy: "git",
        note: null,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
  });
}

/** Read one target, lazily seeding it from its git default first (a
 *  known section key always seeds; a skill id seeds only if
 *  `skills/<id>/SKILL.md` exists). Null = no row and nothing to seed —
 *  for a skill, that's also the "safe to create at this id" signal. A
 *  malformed `target` (wrong shape, unknown keys, bad id/key) is
 *  treated the same as "not found" — read paths never throw. */
export function getTarget(db: Db, target: unknown): TargetRow | null {
  const parsed = parseTarget(target);
  if (!parsed.ok) return null;
  if (parsed.target.kind === "section") {
    seedSection(db, parsed.target.key);
    return sectionRow(db, parsed.target.key);
  }
  seedSkillIfGitShipped(db, parsed.target.id);
  return skillRow(db, parsed.target.id);
}

export interface TargetListItem extends TargetRow {
  kind: "section" | "skill";
  key?: SectionKey;
  id?: string;
}

/** Every section, plus every skill (git-shipped ones seeded first) —
 *  `status: "deleted"` skills excluded unless `includeDeleted`. Sections
 *  are always listed (there is no "deleted" section). */
export function listTargets(db: Db, opts: { includeDeleted?: boolean } = {}): TargetListItem[] {
  const out: TargetListItem[] = [];
  for (const key of SECTION_KEYS) {
    seedSection(db, key);
    const row = sectionRow(db, key);
    if (row) out.push({ kind: "section", key, ...row });
  }
  for (const id of listGitSkillIds()) seedSkillIfGitShipped(db, id);
  const rows = db.select().from(skills).orderBy(skills.id).all();
  for (const row of rows) {
    if (row.status === "deleted" && !opts.includeDeleted) continue;
    out.push({
      kind: "skill",
      id: row.id,
      version: row.version,
      body: row.body,
      editedBy: row.editedBy as TargetRow["editedBy"],
      note: row.note,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      origin: row.origin as TargetRow["origin"],
      description: row.description,
      thread: row.thread,
      status: row.status as SkillStatus,
    });
  }
  return out;
}

/** A target's full version history, newest first. A malformed `target`
 *  returns an empty list — same "read paths never throw" rule as
 *  `getTarget`. */
export function listVersions(db: Db, target: unknown): TargetRow[] {
  const parsed = parseTarget(target);
  if (!parsed.ok) return [];
  if (parsed.target.kind === "section") {
    return db
      .select()
      .from(promptSectionVersions)
      .where(eq(promptSectionVersions.key, parsed.target.key))
      .orderBy(desc(promptSectionVersions.version))
      .all()
      .map((row) => ({
        version: row.version,
        body: row.body,
        editedBy: row.editedBy as TargetRow["editedBy"],
        note: row.note,
        createdAt: row.createdAt,
        updatedAt: row.createdAt,
      }));
  }
  return db
    .select()
    .from(skillVersions)
    .where(eq(skillVersions.skillId, parsed.target.id))
    .orderBy(desc(skillVersions.version))
    .all()
    .map((row) => ({
      version: row.version,
      body: row.body,
      editedBy: row.editedBy as TargetRow["editedBy"],
      note: row.note,
      createdAt: row.createdAt,
      updatedAt: row.createdAt,
      description: row.description,
      thread: row.thread,
      status: row.status as SkillStatus,
    }));
}

// --- the write primitive ----------------------------------------------------

/** Business rules on an already shape-valid `Patch` (parsePatch ran
 *  first): caps, section-only-body, and "creating a skill needs a
 *  body." */
function checkPatchRules(target: Target, patch: Patch, isCreate: boolean): string[] {
  const issues: string[] = [];
  if (target.kind === "section") {
    if (patch.description !== undefined || patch.thread !== undefined || patch.status !== undefined) {
      issues.push("prompt sections accept only body changes");
    }
    if (patch.body !== undefined && bytes(patch.body) > PROMPT_SECTION_MAX_BYTES) {
      issues.push(`prompt section body exceeds ${PROMPT_SECTION_MAX_BYTES} bytes`);
    }
  } else {
    if (patch.body !== undefined && bytes(patch.body) > SKILL_BODY_MAX_BYTES) {
      issues.push(`skill body exceeds ${SKILL_BODY_MAX_BYTES} bytes`);
    }
    if (patch.description !== undefined && patch.description.length > SKILL_DESCRIPTION_MAX_CHARS) {
      issues.push(`skill description exceeds ${SKILL_DESCRIPTION_MAX_CHARS} characters`);
    }
    if (isCreate && patch.body === undefined) {
      issues.push("creating a skill requires a body");
    }
  }
  if (patch.body === undefined && patch.description === undefined && patch.thread === undefined && patch.status === undefined) {
    issues.push("at least one change is required");
  }
  return issues;
}

/** The one write path: every mutation (a UI save, a restore, a reset,
 *  or an approved agent proposal — including creating a skill at
 *  `expectedVersion: 0`, or tombstoning one with `status: "deleted"`)
 *  is this same transactional compare-and-write. `target`/`patch`/
 *  `expectedVersion`/`note` are all `unknown` here — this is the one
 *  place malformed JSON stops being a crash and becomes a value. */
function writeVersion(
  db: Db,
  targetInput: unknown,
  input: { patch: unknown; expectedVersion: unknown; editedBy: "user" | "agent"; note?: unknown },
): WriteResult {
  const targetParsed = parseTarget(targetInput);
  if (!targetParsed.ok) return targetParsed;
  const target = targetParsed.target;

  const versionParsed = parseExpectedVersion(input.expectedVersion);
  if (!versionParsed.ok) return versionParsed;

  const noteParsed = parseNote(input.note);
  if (!noteParsed.ok) return noteParsed;

  const patchParsed = parsePatch(input.patch, target.kind);
  if (!patchParsed.ok) return patchParsed;
  const patch = patchParsed.patch;

  return db.transaction((tx) => {
    // Seed first (inside the same transaction) so expectedVersion means
    // the same thing here as it did when the caller last read the
    // target — a known section key or an existing git-shipped skill is
    // never actually "version 0" by the time we check.
    if (target.kind === "section") seedSection(tx, target.key);
    else seedSkillIfGitShipped(tx, target.id);

    const live = target.kind === "section" ? sectionRow(tx, target.key) : skillRow(tx, target.id);
    const issues = checkPatchRules(target, patch, live === null);
    if (issues.length > 0) return invalid(...issues);

    const currentVersion = live?.version ?? 0;
    if (currentVersion !== versionParsed.version) {
      return { ok: false, code: "conflict", current: live };
    }

    const now = Date.now();
    const nextVersion = currentVersion + 1;
    const note = noteParsed.note ?? null;

    if (target.kind === "section") {
      const body = patch.body ?? live!.body;
      tx.insert(promptSectionVersions)
        .values({ key: target.key, version: nextVersion, body, editedBy: input.editedBy, note, createdAt: now })
        .run();
      tx.insert(promptSections)
        .values({ key: target.key, body, version: nextVersion, editedBy: input.editedBy, note, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: promptSections.key,
          set: { body, version: nextVersion, editedBy: input.editedBy, note, updatedAt: now },
        })
        .run();
    } else {
      const merged = {
        body: patch.body ?? live?.body ?? "",
        description: patch.description ?? live?.description ?? "",
        thread: patch.thread ?? live?.thread ?? false,
        status: patch.status ?? live?.status ?? "active",
      };
      const origin = live?.origin ?? "user";
      // The parent row must exist before the history row can reference
      // it (skill_versions.skill_id has a real FK) — upsert skills
      // first; on a brand-new skill this is the row's very creation.
      tx.insert(skills)
        .values({
          id: target.id,
          origin,
          description: merged.description,
          thread: merged.thread,
          status: merged.status,
          body: merged.body,
          version: nextVersion,
          editedBy: input.editedBy,
          note,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: skills.id,
          set: {
            description: merged.description,
            thread: merged.thread,
            status: merged.status,
            body: merged.body,
            version: nextVersion,
            editedBy: input.editedBy,
            note,
            updatedAt: now,
          },
        })
        .run();
      tx.insert(skillVersions)
        .values({
          skillId: target.id,
          version: nextVersion,
          description: merged.description,
          thread: merged.thread,
          status: merged.status,
          body: merged.body,
          editedBy: input.editedBy,
          note,
          createdAt: now,
        })
        .run();
    }
    return { ok: true, version: nextVersion };
  }) as WriteResult;
}

/** Chad's own edit through the UI — publishes immediately, no approval
 *  gate (PLAN.md: "UI saves ... do not need another approval"). Also
 *  the write behind the Enabled/Disabled toggle, Delete, and New Skill
 *  — every one of those is just a patch. */
export function publishEdit(
  db: Db,
  target: unknown,
  input: { patch: unknown; expectedVersion: unknown; note?: unknown },
): WriteResult {
  return writeVersion(db, target, { ...input, editedBy: "user" });
}

/** Called once Chad approves an agent's proposal card. Same primitive,
 *  `editedBy: "agent"`, the SAME `expectedVersion` the agent's preview
 *  captured — a concurrent edit between proposal and approval surfaces
 *  as an ordinary conflict, never a silent overwrite. */
export function applyApprovedChange(
  db: Db,
  target: unknown,
  input: { patch: unknown; expectedVersion: unknown; note?: unknown },
): WriteResult {
  return writeVersion(db, target, { ...input, editedBy: "agent" });
}

/** Write a historic version's full field snapshot forward as a NEW
 *  version (never rewinds the counter) — this is how a disable, a
 *  delete, or any other edit gets undone. */
export function restoreVersion(
  db: Db,
  targetInput: unknown,
  input: { version: unknown; expectedVersion: unknown },
): WriteResult {
  const targetParsed = parseTarget(targetInput);
  if (!targetParsed.ok) return targetParsed;
  const target = targetParsed.target;

  const versionNumParsed = parsePositiveInt(input.version, "version");
  if (!versionNumParsed.ok) return versionNumParsed;

  let patch: Patch;
  if (target.kind === "section") {
    const historic = db
      .select()
      .from(promptSectionVersions)
      .where(and(eq(promptSectionVersions.key, target.key), eq(promptSectionVersions.version, versionNumParsed.value)))
      .get();
    if (!historic) return invalid(`no such version: ${versionNumParsed.value}`);
    patch = { body: historic.body };
  } else {
    const historic = db
      .select()
      .from(skillVersions)
      .where(and(eq(skillVersions.skillId, target.id), eq(skillVersions.version, versionNumParsed.value)))
      .get();
    if (!historic) return invalid(`no such version: ${versionNumParsed.value}`);
    patch = {
      body: historic.body,
      description: historic.description,
      thread: historic.thread,
      status: historic.status as SkillStatus,
    };
  }
  return writeVersion(db, target, {
    patch,
    expectedVersion: input.expectedVersion,
    editedBy: "user",
    note: `restored v${versionNumParsed.value}`,
  });
}

/** Read the CURRENT git default and write it as a new version with
 *  `status: "active"` (a shipped skill is definitionally active —
 *  resetting a tombstoned one both revives and restores it). Refused
 *  for a user-created target, or a shipped skill whose SKILL.md was
 *  since deleted from the repo. */
export function resetToGitDefault(db: Db, targetInput: unknown, input: { expectedVersion: unknown }): WriteResult {
  const targetParsed = parseTarget(targetInput);
  if (!targetParsed.ok) return targetParsed;
  const target = targetParsed.target;

  if (target.kind === "section") {
    return writeVersion(db, target, {
      patch: { body: GIT_DEFAULT_SECTIONS[target.key] },
      expectedVersion: input.expectedVersion,
      editedBy: "user",
      note: "reset to shipped default",
    });
  }
  const live = getTarget(db, target);
  if (!live || live.origin !== "git") {
    return { ok: false, code: "no-default", message: `${target.id} has no shipped default` };
  }
  const def = readGitSkillDefault(target.id);
  if (!def) return { ok: false, code: "no-default", message: `${target.id}'s shipped file is gone` };
  return writeVersion(db, target, {
    patch: { body: def.body, description: def.description, thread: def.thread, status: "active" },
    expectedVersion: input.expectedVersion,
    editedBy: "user",
    note: "reset to shipped default",
  });
}
