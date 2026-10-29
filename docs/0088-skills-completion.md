# 0088 — Skills: a dynamic, S3-backed catalog (2.3, redrawn)

Status: **draft 3, 2026-10-29 — draft 2 plus Chad's call to drop thread
binding entirely; awaiting approval before implementation.**

## Why (decisions, Chad 2026-10-29)

Draft 1 completed roadmap 2.3 as written (DB catalog, multi-file git
skills, harness mounting). Chad redirected:

- The DB catalog (0054) goes **away entirely** — tables, Settings
  editor, the skill kind of `propose_prompt_change`. Four curated
  defaults that the model almost never uses didn't earn that machinery.
- The shipped runbooks (`ticket`, `review`, `review-guide`, retired
  `ship`) are **removed, fresh start** — rebuilt as needed later, and
  sweatshop's own docs/instruction layer already follows progressive
  disclosure (`system_docs`, instructions appendix). They are not
  re-seeded anywhere.
- Skills become a **dynamic catalog each user builds/brings**: an
  S3-compatible store (rustfs, not minio) as source of truth. The app
  runs on a server; no reliance on the repo checkout's filesystem.
- The agent must be able to **edit any skill and add new ones** —
  write path back to the store, not just reads.
- **Thread binding is dropped entirely** (Chad, same day): the concept
  existed to serve long unattended playbooks (0037/0039's ticket/ship),
  which are gone. Skills are reference material — visible, loadable,
  mountable, writable — never a thread's "way of working". If a future
  bring-your-own runbook genuinely wants unattended long-run treatment,
  binding returns as a front-matter flag on a much smaller base.

What survives from draft 1's research (unchanged by the pivot): the
model-visible catalog (instructions appendix), progressive disclosure
(`use_skill` file reads), and mounting into harness calls via the AI
SDK's native `HarnessAgent` `skills` option (pi/codex materialize at
`~/.agents/skills`, claude at `~/.claude/skills`; cursor's adapter has
no skills surface — skipped). Wherever skills live, the app only ever
reads them into memory; the adapters write files into sandboxes
themselves, so the store choice is purely about source of truth and
the write path.

## The store

**Layout.** One bucket, one optional prefix. A skill is an object
family: `<prefix>/<id>/SKILL.md` plus optional sibling files
(`<id>/reference.md`, `<id>/examples/…`). The Agent Skills shape —
front matter `name`, `description` (description is the model-facing
trigger text), body markdown, supporting files loaded on demand.

- `<id>` = first path segment; must match `^[a-z][a-z0-9-]{0,40}$`
  (today's `SKILL_ID`), anything else is skipped at listing.
- `status: disabled` in front matter hides a skill without deleting
  it. `thread: true` is no longer read — binding is gone (below).
- Limits: ≤16 files per skill, each ≤64 KiB, ≤256 KiB per skill.

**Client.** `@aws-sdk/client-s3` against the rustfs endpoint (SigV4,
standard S3 API) — one new dependency, named here per AGENTS.md.
Config is env, absent = empty catalog and no errors (bring-your-own is
a valid state): `SKILLS_S3_ENDPOINT`, `SKILLS_S3_REGION`,
`SKILLS_S3_BUCKET`, `SKILLS_S3_ACCESS_KEY_ID`,
`SKILLS_S3_SECRET_ACCESS_KEY`, `SKILLS_S3_PREFIX`.

**Access layer** (`lib/skills/store.ts`, replacing `lib/skills.ts` +
`lib/skill-files.ts`): a thin injectable client seam so tests fake the
bucket, never the network. Listing (`ListObjectsV2` under the prefix,
grouped by first segment) cached in memory 60 s; bodies cached LRU
(bounded, 32 skills' worth). Store errors are values, never throws
into a turn: an unreachable store reads as an empty catalog plus a
status string for the Settings card.

**Read shape.** `listSkills()` (all non-disabled), `readSkill(id)`
(SKILL.md parsed) and `readSkillFile(id, path)` (supporting file).
`listThreadSkills()` is deleted with binding.

## Surfaces

1. **Instructions appendix** (every chat): `# Skills` section, one
   line per skill — `id — description` (description capped ~200 chars).
   Catalog ≤20 lines; a bigger catalog falls back to today's
   "use_skill lists them" sentence. Discovery becomes free; no tool
   round-trip to know a skill exists.
2. **`use_skill` grows `file`**: `{id}` returns body + file list;
   `{id, file: "reference.md"}` returns that file — the chat thread's
   progressive disclosure. Unknown file → value-shaped error listing
   what exists.
3. **Harness mounting**: every harness call passes the catalog as
   `HarnessV1Skill`s (`name`, `description`, body with `{{owner}}`
   rendered, `files[]`). Loaded fresh per call — a saved edit reaches
   the next call with no restart. Cursor: no adapter surface, skipped.
4. **Settings**: the skills editor is deleted. A small read-only card
   shows store status (configured/unconfigured, N skills, last sync
   error if any).
5. **Thread binding is removed**: skills never join instructions by
   binding. Child threads keep their 800-step budget through
   `hasParent` (unchanged); the skill-only budget CONTINUATION
   (`lib/chat/budget.ts`) is deleted along with
   `THREAD_SKILL_MAX_STEPS`/`resolveMaxSteps`'s skill path.

## The write path (agent edits and additions)

New tool **`save_skill`**: `{id, body, files?: [{path, content}[]],
   note?}`. Description/thread/status live in the body's front matter —
   SKILL.md is the single source; the tool parses and validates it
   (id shape, file rules, limits) before anything is written.

- Writes are PUTs: each file, then `<id>/manifest.json`
  ({files, sizes, updatedAt, author}) last — readers skip a skill
  whose manifest is missing or names files that aren't there (a torn
  multi-file write never half-loads).
- **Approval-gated** (the existing `chatApprovalHook` pattern, like
  `create_pr`): skills are prompt-level influence over every future
  turn and mounted harness, so a write is one click, not silent.
  Bucket **versioning on** (rustfs supports object versioning): the
  approval card for an edit of an existing skill shows a unified
  diff (old object version vs new body), and revert is a copy of the
  prior version — cheap insurance without re-growing a version DB.
- No delete tool in v1 (disable via `status: disabled` in front
  matter; deletion is a store-side chore).

## Removals

- `skills/` directory (ticket, review, review-guide, ship) — deleted.
- `skills`/`skill_versions` tables (drop migration), `lib/skills.ts`,
  `lib/skill-files.ts`, `db/prompt-settings.ts` skill paths, the
  Settings skills editor UI, `propose_prompt_change`'s skill kind
  (section edits stay), skills-lock seed references, AGENTS.md/ROADMAP
  2.3 text updates.
- The whole binding surface: `conversations.skill` column (dropped in
  the same migration), `?skill=` on `/` and `POST /api/x/chat`,
  `start_thread`'s `skill` param, `loadSkillStep`, the
  thread-skill pickers (composer, new chat), skill mentions in thread
  chips/wake text, and the skill-kind rows of the route-validation
  tests. `start_thread`'s doc/PROMPT pass a brief, never a skill id.

## Verification

- Unit (fake client seam): listing/groups/front matter, id and limit
  validation, cache TTL, torn-manifest skip, store error → empty
  catalog + status; `save_skill` validation, diff shape, PUT order
  (manifest last); instructions appendix rendering (cap, empty
  catalog); `use_skill` file reads; binding removals (`?skill=`
  rejected, `start_thread` schema has no skill, child budget still 800
  via parent).
- Mock-model chat tests: instructions carry the appendix; harness call
  start receives mapped skills (assert on the built agent, no podman);
  no skill path exists in a turn's instruction assembly.
- Live smoke (manual, against real rustfs): mount visible in a pi
  session's own skill listing; edit a skill via `save_skill`, next
  harness call sees the new body; kill the store, chats run with an
  empty catalog and the Settings card shows why.

## Changelog

"Skills are now a bring-your-own catalog on S3-compatible storage:
visible to every chat and mounted into pi, claude and codex runs, with
the agent able to propose edits and new skills (one-click approval).
Bound threads and the built-in runbooks are gone."
