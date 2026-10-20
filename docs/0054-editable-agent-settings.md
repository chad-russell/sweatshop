# 0054 — Editable agent settings: prompt text and skills, database-backed

Status: **Approved by Chad in chat — implemented on glen/editable-prompts-skills; pending review and merge.**

## Why

Today every word of the agent's prompt is a TS string literal
(`workflows/chat/instructions.ts`'s `BASE_INSTRUCTIONS`/`HARNESS_STEERING`/
`HOST_ROUTING`) or a markdown file in the repo (`skills/<id>/SKILL.md`,
read live by `lib/skills.ts`). Changing how the agent is told to behave
means editing code and shipping a deploy. Sweatshop is a single-owner
tool — Chad is both the maintainer and the only user — so there is no
reason the prose half of "how the agent behaves" should require a
commit, and no reason the agent itself can't propose that prose change
when it notices its own instructions are wrong, incomplete, or stale —
the same way it already drafts a PR or a new project for Chad's
approval rather than doing either unilaterally. The enforcement half
(which tools exist, what needs approval, what `exec` will refuse) must
stay in code regardless, so the editor must never look like it
controls that.

## Product boundary (restated from PLAN.md)

Chad can edit all app-supplied agent prompt text — the base
instructions, the harness/host steering paragraphs, and every skill's
body — plus manage the skill catalog (create, edit metadata, disable,
delete). The agent can propose every one of those same changes —
editing a section, creating a skill, changing a skill's description/
thread-binding/status, disabling or deleting a skill — through one
tool; **every agent-proposed change requires Chad's explicit approval
before anything is written**, exactly like `create_pr` or
`create_project`. Chad's own edits through the UI publish immediately,
through the identical versioned, restorable store — there are not two
mechanisms, only two entry points into one. Tool availability, approval
gates, and validation stay in application code; the editor is clearly
labeled as prose/catalog-data-only so it never implies a hidden way to
bypass a code-level check. Git-shipped text seeds SQLite once; after
that SQLite is truth.

## Scope

In scope:
- The three named instruction blocks in `buildInstructions`'s input —
  editable by Chad (UI) and proposable by the agent (approval-gated).
- The skill catalog: body, description, thread-binding, and status
  (active/disabled/deleted) — create/edit/disable/delete, all of it
  editable by Chad (UI, immediate) **and** proposable by the agent
  (approval-gated) through the same store calls. The three shipped
  skills (`ship`, `ticket`, `review`) become the first DB rows via
  seeding.
- Version history, optimistic concurrency, diff preview, restore,
  reset. Every material change to a skill — including disabling it and
  deleting it — is a new version, so every one of them is undoable by
  restoring an earlier version. Nothing here is an irreversible write.
- One agent tool covering all of the above, approval-gated.
- A Settings UI surface for all of the above.

Out of scope (unchanged by this doc):
- Per-repo `AGENTS.md`/README appendices (`loadRepoDocsStep`) — still
  read live from the sandbox's checkout, never stored here.
- Which skill a thread is bound to (`conversations.skill`) — still a
  plain column holding a skill id; only the skill's *content and
  catalog membership* move into this system.
- Tool wiring (`buildChatTools`, `hasSandbox`/`hasProject`/`hosts`
  gating), every `chatApprovalHook` gate, `lib/hosts/lockout.ts`,
  provider/route validation (`lib/providers/resolve.ts`). An agent
  proposing to disable or delete a skill changes DATA this code reads
  (whether a skill is in the bindable catalog); it never changes the
  CODE that reads it — the gate itself cannot be proposed away.
- Creating *new* named instruction sections (the set of three is fixed
  code, not data — adding a fourth is a future code change plus
  migration, same as adding a new conversations column). An agent can
  propose new *text* for one of the three; it cannot propose a fourth.

## Terminology: targets

A **target** is one editable thing: either a **section** (one of the
three fixed instruction blocks, keyed `base` | `harness_steering` |
`host_routing`) or a **skill** (`skills.id`, open-ended, including ids
that don't exist yet — see creation below). Both are versioned the same
way through one write primitive (below); they get separate tables
because their shapes differ (a skill carries description/thread/status,
a section doesn't) and the codebase's own convention is explicit typed
tables over a polymorphic one (compare `harnessCalls`/`sandboxes`/
`previews` — never a generic `entities` table).

## Schema

Two pairs of tables, added to `db/schema.ts`. `version` is a per-row
monotonic counter; every write — a UI save, a restore, a reset, or an
approved agent proposal, for *any* field including a skill's status —
goes through one transactional primitive that bumps it and appends a
history row in the same transaction. This is the "single store/API"
PLAN.md asks for, and it's also what makes every change reversible:
if it's a version, `restoreVersion` can get back to it.

```ts
/**
 * 0054: the three fixed app-prompt blocks buildInstructions assembles.
 * Exactly one row per key, seeded from the current git default
 * (instructions.ts's exported consts) the first time it's read.
 */
export const promptSections = sqliteTable("prompt_sections", {
  /** "base" | "harness_steering" | "host_routing". */
  key: text("key").primaryKey(),
  body: text("body").notNull(),
  version: integer("version").notNull(),
  /** "git" (the seed row only) | "user" | "agent". */
  editedBy: text("edited_by").notNull(),
  note: text("note"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const promptSectionVersions = sqliteTable(
  "prompt_section_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    key: text("key").notNull().references(() => promptSections.key),
    version: integer("version").notNull(),
    body: text("body").notNull(),
    editedBy: text("edited_by").notNull(),
    note: text("note"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("prompt_section_versions_key_version_idx").on(t.key, t.version)],
);

/**
 * 0054: the skill catalog, DB-backed after first read (was fs-only,
 * 0039). `origin` distinguishes a shipped `skills/<id>/SKILL.md` (can
 * reset to its current git content) from a Chad/agent-created skill
 * (no git default to reset to). `status` replaces a plain boolean
 * "enabled": "active" | "disabled" | "deleted" — ALL THREE are
 * versioned alongside description/thread/body, because disabling and
 * deleting must be exactly as restorable as any text edit (no row is
 * ever hard-deleted; "deleted" is a tombstone status, not a DELETE).
 */
export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  origin: text("origin").notNull(),
  description: text("description").notNull(),
  thread: integer("thread", { mode: "boolean" }).notNull().default(false),
  /** "active" | "disabled" | "deleted". */
  status: text("status").notNull().default("active"),
  body: text("body").notNull(),
  version: integer("version").notNull(),
  editedBy: text("edited_by").notNull(),
  note: text("note"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const skillVersions = sqliteTable(
  "skill_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    skillId: text("skill_id").notNull().references(() => skills.id),
    version: integer("version").notNull(),
    description: text("description").notNull(),
    thread: integer("thread", { mode: "boolean" }).notNull(),
    status: text("status").notNull(),
    body: text("body").notNull(),
    editedBy: text("edited_by").notNull(),
    note: text("note"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("skill_versions_skill_id_version_idx").on(t.skillId, t.version)],
);
```

Title is **not** a column: like today, it's the body's first `# ` line,
parsed the same way `lib/skills.ts`'s `parse()` already does. The editor
shows it live (derived from the textarea as you type), so there's one
source of truth instead of a title field that can drift from the body.

Caps (new constants, same spirit as `lib/plan.ts`'s `PLAN_MAX_BYTES`):
`PROMPT_SECTION_MAX_BYTES = 32 * 1024`, `SKILL_BODY_MAX_BYTES = 64 * 1024`
(skills are full runbooks, sized like `PLAN_MAX_BYTES`), skill
`description` capped at 500 chars (matches `projects.description`'s
tool-schema cap). Version history is never pruned — text rows are
small and this is a single-owner store; same policy as `pending_inputs`
and `harness_calls`, which also grow unbounded. There is deliberately
**no hard-delete / permanent-purge operation anywhere in the app** —
Chad chose not to add a permanent purge for this phase.

Migration: `drizzle/0057_lovely_ezekiel_stane.sql`, after
`0056_context_meter.sql`. The missing 0056 Drizzle snapshot was
reconstructed to avoid generating the already-shipped usage columns a
second time; 0057 has a strictly later journal timestamp, so upgrades
from deployed 0056 apply correctly.

## The write primitive and store API

One function does every mutation — a section's body, or any subset of
a skill's body/description/thread/status (including creating a brand
new skill, or tombstoning an existing one) — because PLAN.md asks for
one store that both the UI and an agent tool call, and because "every
material change is a restorable version" only holds if every material
change goes through the same versioning path.

```ts
// db/prompt-settings.ts
type SectionKey = "base" | "harness_steering" | "host_routing";
type Target = { kind: "section"; key: SectionKey } | { kind: "skill"; id: string };

/** A skill patch may set any subset of its versioned fields; a section
 *  patch only ever has `body` (enforced — description/thread/status on
 *  a section patch is a validation error, not silently ignored). */
interface Patch {
  body?: string;
  description?: string;
  thread?: boolean;
  status?: "active" | "disabled" | "deleted";
}

function writeVersion(
  db: Db,
  target: Target,
  input: { patch: Patch; expectedVersion: number; editedBy: "user" | "agent"; note?: string },
):
  | { ok: true; version: number }
  | { ok: false; code: "conflict"; current: CurrentRow | null }
  | { ok: false; code: "invalid"; issues: string[] };
```

Inside one sqlite transaction: re-read the live row (absent = treated
as version 0 — this is how creation works, below). Compare
`(row?.version ?? 0) === input.expectedVersion` — mismatch returns
`conflict` with the row as it actually is now (`current: null` if the
target still doesn't exist, e.g. two proposals racing to create the
same id), so the caller can show what changed instead of guessing.
Match: merge `patch` over the row's current fields (a section patch is
just `body`), insert a history row at `version + 1` (full field
snapshot — a skill's history row always carries description/thread/
status/body together, never a partial), upsert the live row, return
`ok`. This is the same shape as `db/plans.ts`'s `approvePlanRow`
(running-only write, `changes` checked) and the same "value-shaped,
never throws" convention as `setProjectModelSettings`.

**Creating a skill is the same primitive, not a separate code path**:
call it with `target: { kind: "skill", id: "<new-id>" }`,
`expectedVersion: 0` (no row exists yet) and a patch carrying at least
`body`; defaults fill in anything the patch omits (`description: ""`,
`thread: false`, `status: "active"`). `origin` is set once at creation
(`"user"` for anything created through this path — Chad or an agent —
there is no `"agent"` origin; `origin` only ever distinguishes "came
from a git file at seed time" from everything else) and never changes
across versions. Creating with an id that already exists is an ordinary
conflict (`expectedVersion: 0` but the row's real version is ≥ 1).

**Disabling or deleting a skill is the same primitive with `patch:
{ status: "disabled" }` or `{ status: "deleted" }`** — not a separate
"remove" function, not a real `DELETE FROM skills`. Both are reversible
by restoring any earlier version whose `status` was `"active"`
(including the shipped version that reset writes). "Deleted" differs
from "disabled" only in default catalog visibility (below) — the row,
its full version history, and its id all keep existing.

Every caller is a thin wrapper around `writeVersion`, differing only in
where `patch` comes from and in `editedBy`:

- `publishEdit(db, target, { patch, expectedVersion, note? })` —
  `editedBy: "user"`. The UI's Save button, the Enabled/Disabled
  toggle, the Delete button, and the New Skill form all call this
  directly — no approval gate, per PLAN.md ("UI saves by the person
  using the installation do not need another approval"). A delete
  confirm dialog still asks for confirmation (it's an impactful
  action), but it is no longer a scary irreversible one — the dialog
  copy says so and points at History/Restore.
- `restoreVersion(db, target, { version, expectedVersion })` — reads
  that historic row's full field snapshot from the `*_versions` table
  and writes it as a NEW version (never rewinds the counter —
  forward-only history, same as everything else in this store).
  `editedBy: "user"`, `note: "restored v<N>"`. This is how an agent's
  or Chad's disable/delete gets undone: restore the version from
  before it.
- `resetToGitDefault(db, target, { expectedVersion })` — reads the
  **current** git default (below) and writes it as a new version with
  `status: "active"` (resetting a tombstoned shipped skill both revives
  and restores it — resetting is defined as "become exactly what's
  shipped now", and a shipped skill is definitionally active).
  `editedBy: "user"`, `note: "reset to shipped default"`. Refused with
  `code: "no-default"` for an `origin: "user"` target (no git source)
  or a shipped skill whose `skills/<id>/SKILL.md` was since deleted
  from the repo.
- `applyApprovedChange(db, target, { patch, expectedVersion, note })`
  — called once Chad approves an agent's proposal card (below).
  `editedBy: "agent"`. The SAME `expectedVersion` captured when the
  agent proposed it, so a concurrent edit between proposal and approval
  surfaces as an ordinary conflict, not a silent overwrite.

Reads: `getTarget(db, target)` returns `{ patch fields, version,
updatedAt, editedBy, note, origin }`, lazily seeding the row first if
absent for a known section key or an existing `skills/<id>/SKILL.md`
(`INSERT ... ON CONFLICT DO NOTHING` from the git default, then
re-select — safe under a concurrent second reader, same pattern as
`db/plans.ts`'s `openPlanReview`); absent and not seedable (a `skill`
id that is neither a DB row nor a git directory) returns `null`, which
is also the "safe to create at this id" signal. `listTargets(db,
{ includeDeleted?: boolean })` returns the three sections plus every
skill row (`status: "deleted"` rows excluded unless `includeDeleted` —
the default catalog/editor list stays clean; a "Trash" filter in the
UI passes `includeDeleted: true`), seeding any `skills/<id>/SKILL.md`
directory that has no row yet (readdir, like `lib/skills.ts` does
today) before selecting — this is how a skill file added to the repo
after this feature ships appears automatically on next read, no
migration needed.

**Git defaults, read live, no new files.** For skills this is
unchanged: `skills/<id>/SKILL.md`, parsed by the existing front-matter
+ H1 logic. For the three sections, `instructions.ts` keeps exporting
`BASE_INSTRUCTIONS`/`HARNESS_STEERING`/`HOST_ROUTING` as plain consts —
reading "the current git default" is just importing the module; there
is no need to move this prose into its own files. A small exported map
(`GIT_DEFAULT_SECTIONS: Record<SectionKey, string>`) is the one thing
`db/prompt-settings.ts` needs from `instructions.ts`.

## `lib/skills.ts`: same contract, DB-backed underneath

`readSkill`/`listSkills`/`listThreadSkills` keep their exact names and
return shapes; new-binding callers (`app/api/x/chat/route.ts` and
`lib/agent/tools/start-thread.ts`) use `listThreadSkills` instead of
`readSkill` to refuse disabled, deleted and non-thread skills.
Internally they become thin calls into `db/prompt-settings.ts`'s
`listTargets`/`getTarget` filtered to skills, with `listThreadSkills`
additionally filtering `thread && status === "active"`.

**Explicit, resolved (not an open question): a thread's already-bound
skill keeps running regardless of status.** `loadSkillStep` (turn-time)
looks a skill up by id unconditionally — `"disabled"` and `"deleted"`
both only hide a skill from the picker and from a *new* `use_skill`
bind; neither one reaches into a conversation that already has
`conversations.skill` set to that id and stops it mid-thread. A thread
bound to a skill that gets fully removed from the DB can't happen
(nothing hard-deletes `skills` rows), so `loadSkillStep`'s lookup by id
always finds *some* row for an id that was ever validly bound — it may
just be a disabled/deleted one, and it still drives the thread exactly
as its current version reads.

## Runtime wiring: `buildInstructions`

`buildInstructions` stays pure (no DB/sandbox access, unit-testable as
today) but gains one new input — the resolved section bodies — instead
of reaching for the module consts directly:

```ts
export interface BuildInstructionsInput {
  hasSandbox: boolean;
  hosts: readonly { ... }[];
  repoDocs: readonly RepoDoc[];
  skill?: { id: string; title: string; body: string } | null;
  /** 0054: resolved section bodies; omitted = the git defaults
   *  (BASE_INSTRUCTIONS/HARNESS_STEERING/HOST_ROUTING) — existing
   *  unit tests and any caller that doesn't pass it keep working
   *  unchanged. */
  sections?: { base: string; harnessSteering: string; hostRouting: string };
}
```

A new step in `workflows/chat/steps/turn.ts`, `loadPromptSectionsStep`,
mirrors `loadSkillStep`: `"use step"`, calls `getTarget` for all three
keys (seeding on first touch), returns the three strings.
`workflows/chat/turn.ts` calls it alongside the existing
`loadSkillStep` call and passes the result into `buildInstructions`.
Nothing else in the turn changes shape.

## Agent tool: `propose_prompt_change`

Added to `workflows/chat/tools/core.ts` beside `use_skill`/`ask_chad` —
available in every chat, since it's a meta-capability, not a
project-specific one. It covers everything the UI can do to a target —
edit a section's text; create a skill; change a skill's description,
thread-binding, or status (including disabling or deleting it); edit a
skill's body — because restricting the agent to body-only prose would
mean Chad has to do every catalog change by hand even when the agent
is the one that noticed a skill should be retired or split. The safety
property is not "the agent can only touch harmless fields" — fields
aren't harmless or not, the write path is what matters — it's "nothing
the agent proposes is written until Chad approves it," which holds
uniformly for every field.

```ts
propose_prompt_change: tool({
  description:
    "Propose a change to one of the app's own prompt sections (base instructions, harness " +
    "steering, host routing) or to the skill catalog: edit a skill's body/description/thread " +
    "binding, create a new skill, or disable/delete an existing one (disabling and deleting " +
    "are both reversible — Chad can restore any earlier version from Settings). Chad reviews " +
    "what would change and approves or denies — nothing is written until he approves. This " +
    "only changes prompt text and the skill catalog's data; it cannot add tools, skip " +
    "approvals, or change what exec/create_pr will refuse.",
  inputSchema: z.object({
    kind: z.enum(["section", "skill"]),
    key: z.string().describe("section key (base|harness_steering|host_routing), or a skill id (new or existing)"),
    body: z.string().max(SKILL_BODY_MAX_BYTES).optional(),
    description: z.string().max(500).optional().describe("skill only"),
    thread: z.boolean().optional().describe("skill only — whether it can be bound to a thread"),
    status: z.enum(["active", "disabled", "deleted"]).optional().describe("skill only"),
    note: z.string().max(500).describe("One line on what changed and why — shown on the approval card"),
  }),
  execute: async (input, { toolCallId }) => {
    // Validates: at least one patch field set; a `kind: "section"` input
    // only carries `body` (description/thread/status rejected, no ask —
    // sections have no such fields); an unknown-and-ungit-shippable skill
    // id with no body is rejected ("creating" needs at least a body).
    const preview = proposePromptChange(input); // value-shaped; invalid/not-found return here, no ask
    if (!preview.ok) return preview;
    await pendingStep(conversationId, toolCallId, preview.summary, "approval", preview.card);
    const answer = await chatApprovalHook.create({ token: toolCallId });
    if (!(answer.kind === "approval" && answer.approved)) {
      const comment = answer.kind === "approval" ? answer.comment?.trim() : undefined;
      return { ok: false, code: "denied", message: comment ?? "Chad declined — nothing was changed" };
    }
    return applyApprovedChangeStep(preview.target, preview.patch, preview.expectedVersion, input.note);
  },
}),
```

Same shape as `create_project`/`create_pr`: validate → preview → Chad's
explicit approval via `chatApprovalHook` → write. `preview.card` carries
`{ kind: "prompt_change", target, title, currentVersion, patch,
diff?: DiffLine[] }` — a body change renders as a line diff (`diffLines`
against the current body, or against `""` for a brand-new skill, which
naturally renders as "every line added", no special case); a pure
metadata/status change (no `body` in the patch) renders as a plain
before→after list (`status: active → deleted`, `thread: false → true`)
instead of a text diff, since there's no prose to diff. `diffLines`
(currently in `lib/plan.ts`, pure, LCS-based, no dependency) gets pulled
into a shared module (e.g. `lib/text-diff.ts`) since it's no longer
plan-specific; `lib/plan.ts` re-exports it so nothing else breaks. No
new dependency either way.

## UI

`/settings` gains an "Agent prompts" section: the three named blocks,
each a row (name + hint, e.g. "Base instructions" / "Every chat's
top-level system prompt") that opens an editor — textarea, Save,
"Compare to shipped default" (fetches the git default once, renders
`diffLines` the same way `components/plan-card.tsx` already renders a
diff), "Reset to shipped default" (confirm dialog), and "History"
(version/editedBy/note/when list, each row's "Restore"). A "Preview
assembled prompt" view runs `buildInstructions` with representative
flags (`hasSandbox: true`, a sample host, no repo docs, no skill) and
renders it with each piece labeled — `# Repo instructions: ...` and
skill sections already carry their own visible headers
(`buildRepoDocsSection`, the `# Skill: <title>` block); the preview adds
one line above the repo-docs and skill regions: *"Not editable here —
read live from the repo / the Skills editor."* This directly satisfies
PLAN.md's "repo instructions and skill bindings remain independently
sourced and visibly identified."

A new "Skills" section (own page or a `/settings` tab — implementation
detail, not architectural) lists every **active or disabled** skill by
default (a "Show deleted" toggle reveals tombstoned ones, same
`includeDeleted` flag the store takes): id, derived title, thread
badge, a status control (Active / Disabled / Deleted — any transition
is a `publishEdit` call, immediate, versioned, no special-casing of
which direction), Edit (same editor pattern as a section, plus
description and thread checkbox, all four fields — body, description,
thread, status — versioned together; "Reset to shipped default" hidden
for `origin: "user"` rows). "New skill" opens the same editor blank (id
input validated against the existing `^[a-z][a-z0-9-]{0,40}$` pattern),
creates at version 1 via `publishEdit` with `expectedVersion: 0`.
History and Restore work identically on a deleted row — restoring a
pre-deletion version is how Chad undoes a delete, agent-proposed or his
own, without a separate "undelete" code path (a dedicated "Undelete"
button that is sugar for "restore the latest version whose status
wasn't deleted" is a reasonable UI nicety, not a new store operation).

Every editor carries the fixed boundary line the whole feature is built
around: *"This edits prompt text and the skill catalog's data. Tool
access, approvals (create_pr, exec, project create/delete, this
editor's own agent-proposed changes), and provider/model validation are
enforced in code and cannot be changed here."*

Agent proposals need no bespoke Settings UI: they land as an ordinary
approval card in the chat that proposed them (same component family as
`create_pr`'s and `create_project`'s cards, new variant for `kind:
"prompt_change"` rendering either a diff or a before→after field list),
and the Inbox already surfaces "needs you" for any unresolved
`pending_inputs` row — reusing that is less surface than inventing a
second review queue inside Settings.

## Failure modes

- **Seed race** (two requests touch an unseeded target at once):
  `ON CONFLICT DO NOTHING` + re-select; no error, no duplicate.
- **Concurrent edit** (UI save vs. an agent's approved proposal landing
  first, or two browser tabs): `writeVersion` returns `conflict` with
  the row as it now stands; the UI shows "this changed since you
  loaded it — reload to see the new version" rather than clobbering.
- **Approval outlives a concurrent edit**: the same conflict path —
  Chad's approval click resolves the `pending_inputs` row (so it stops
  showing as pending) but the write itself fails value-shaped; the
  approval card's follow-up tells Chad to ask the agent to re-propose
  against the new version.
- **Two proposals race to create the same new skill id**: whichever
  approval lands first wins the `expectedVersion: 0` write; the second
  conflicts (`current` carries the row that now exists) and the agent
  is told to edit the existing skill instead of creating a duplicate.
- **Reset with no git default** (`origin: "user"` target, or a shipped
  skill whose `skills/<id>/SKILL.md` was since deleted from the repo):
  `code: "no-default"`, Reset button disabled/hidden client-side once
  the detail fetch reports no default.
- **An agent proposes deleting (or disabling) a skill a live thread is
  bound to**: allowed, after Chad's approval like any other proposal —
  but never silently equivalent to nothing happening, and never
  irreversible. The approval card for a status-changing proposal
  against a skill with live bound threads names them, so Chad approves
  with that in view. Once applied, that thread's next turn still finds
  the skill row (tombstones never disappear) and follows its current
  (unchanged by status) body; if Chad wants the old behavior back, he
  restores the pre-change version from History.
- **Oversized body**: rejected before any DB write (`code: "invalid"`,
  the cap named in the message) — same "value-shaped, repairable"
  convention as every other tool input.
- **A section patch carries skill-only fields, or a skill patch is
  empty**: rejected `code: "invalid"` before any approval card is ever
  built — same pre-validation discipline as `create_project`'s checked
  input.
- **Agent proposes against a target it misnamed** (a section key that
  doesn't exist, or references a skill id with no body to create it
  and no existing row to edit): `code: "not-found"`/`"invalid"`
  returned to the model before any approval card is ever shown to Chad.

## Upgrade path

- **New skill file lands in `skills/` after a deploy**: appears the
  next time `listTargets`/`listSkills` runs (lazy seed on read) — no
  migration, no restart-triggered backfill needed.
- **A future commit changes `BASE_INSTRUCTIONS` (or a shipped skill's
  file) in git**: the DB row is untouched — deploy never overwrites an
  active row, seeded or not, edited or not (PLAN.md's explicit rule).
  Chad sees the drift only by opening the editor's "Compare to shipped
  default" and choosing to Reset (or hand-merge by editing the
  textarea). This is a conscious tradeoff: nothing auto-adopts an
  upstream prompt change, ever.
- **A fourth named section is wanted later**: code change (new key in
  the `SectionKey` union, a new git-default const, a migration seeding
  the new `prompt_sections` row) — the schema already shaped for it
  (one more row, no table change), but adding the key itself is
  intentionally not data-driven.

## Testing

- **Store layer** (`tests/prompt-settings.test.ts`, per-worker temp DB
  per AGENTS.md convention): seeding idempotency (seed twice, one row);
  `writeVersion` conflict on a stale `expectedVersion`, including the
  create-collision case (`expectedVersion: 0` against an id that
  already exists); restore writes a new version rather than rewinding;
  reset reads the *current* git const/file, not a cached copy, and
  revives a tombstoned shipped skill to `status: "active"`; a section
  patch carrying `status`/`thread`/`description` is rejected; a skill
  created with `expectedVersion: 0` and no body is rejected; oversized
  body rejected before any write.
- **Tombstone semantics**: disabling, then deleting, then restoring a
  skill walks its full version sequence and ends with `status:
  "active"` and the pre-delete body — asserted via `listTargets`
  (excludes the deleted version while tombstoned, includes it again
  once restored) and `includeDeleted: true` (shows it throughout).
- **`lib/skills.ts`** (extends `tests/skills.test.ts`): the three
  shipped skills seed on first read with `origin: "git"`; disabling or
  deleting one drops it from `listThreadSkills` but `readSkill` still
  returns its current version for an already-bound thread; a DB-only
  (`origin: "user"`) skill behaves identically to a shipped one
  everywhere except reset.
- **`buildInstructions`** (extends the existing instructions test):
  omitting `sections` reproduces today's exact output (regression
  guard against the refactor); passing custom `sections` overrides them
  verbatim.
- **Tool/approval flow** (mock-model harness, same pattern as the
  `create_project`/`create_pr` tests): `propose_prompt_change` covers
  all four shapes — section body edit, new skill creation, skill
  metadata-only edit, skill status change (disable and delete) — each
  asserting: an invalid/not-found input returns to the model with no
  approval card raised; denial writes nothing; approval writes exactly
  once with `editedBy: "agent"` and the exact patch fields proposed; an
  approval racing a concurrent UI save surfaces the conflict instead of
  overwriting it.
- **API routes**: `PUT`/status-change without `expectedVersion`
  matching current → 409 with the live row; skill creation rejects a
  malformed id the same way `create_project`'s id regex does.

## Decisions at approval

Chad approved 32 KiB per prompt section, 64 KiB per skill body, 500 characters per skill description, and no hard-purge feature for now. Tombstones and history persist. The agent can propose every UI-supported mutation, approval-gated.
