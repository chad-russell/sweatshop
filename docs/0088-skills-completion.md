# 0088 — Skills 2.3 completion: visible catalog, multi-file skills, harness mounting

Status: **draft 2026-10-29 — awaiting approval before implementation.**

## Why

Skills work (0039 thread skills, 0054 DB catalog + editing) but three gaps
keep them underused, benchmarked against the Agent Skills convention the
wider harness world converged on (Claude Code's SKILL.md standard; the
AI SDK harness adapters now implement it natively):

1. **The model can't see the catalog.** Turn instructions say "use_skill
   with no id lists them" — discovering a skill costs a tool round-trip,
   and nothing ever matches a task to a skill's description. Claude-style
   harnesses inject every skill's name+description up front (~100 tokens
   each) so the model auto-invokes when relevant.
2. **A skill is one flat file.** Long reference material must either
   bloat the body (resent every turn for a thread skill) or not exist.
   The Agent Skills convention is a directory: `SKILL.md` (concise, ≤500
   lines) + supporting files loaded on demand.
3. **Skills never reach the harnesses doing the actual editing.** A
   `ticket` thread delegates implementation to pi/claude — the harness
   gets the raw task, no runbook. The AI SDK now has a first-class
   answer: `HarnessAgent` takes `skills` and materializes them into each
   runtime's native skill directory (pi/codex `~/.agents/skills`,
   claude `~/.claude/skills`), manifest-tracked, incremental. Cursor's
   adapter has no skills support (nothing in its surface) — it is
   skipped, and its harness-steering text stays unchanged.

## What changes

### 1. Catalog appendix in turn instructions

`buildInstructions` gains a `skills` appendix (after repo docs), built
from `listActiveSkills()` at turn start (same lazy-read path as today):

```
# Skills
- ticket — Take a ticket from an approved outline through implementation, review, fixup, and shipping.
- review — Fresh-eyes review of a branch …
…
use_skill({id}) loads one into transcript history.
```

- One line per active skill: `id — description` (description capped at
  ~200 chars), thread skills marked `*`. A thread running a bound skill
  still lists the catalog (the model may need a second runbook).
- `use_skill`'s own list mode stays — the appendix makes discovery free,
  not redundant-free.
- The base instructions' skills paragraph shrinks to point at the
  appendix (the "use_skill with no id lists them" sentence goes — the
  catalog is now in front of the model).
- Cap the appendix (e.g. 20 skills) so a large user catalog can't bloat
  every turn; beyond the cap, keep the list-call fallback sentence.

### 2. Multi-file skills: `skill_files` table + git shape + `use_skill` file reads

- **Storage:** new `skill_files` table (`skill_id`, `path`, `content`,
  `version`, FK to `skills`), edited through the same versioned write
  path (`propose_prompt_change` for the agent — a proposal diff includes
  files; Settings UI gains a files editor). Path rules: POSIX-relative,
  no `..`/absolute, ≤64 chars, ≤16 files per skill, each ≤64 KiB.
- **Git shape:** `skills/<id>/` may hold files beside `SKILL.md`
  (`reference.md`, `examples/…`). `lib/skill-files.ts` reads them; the
  lazy seed and guarded upgrades version them together with the body.
- **Thread binding:** unchanged — the BODY still joins instructions
  (thread skills stay lean procedures; reference material stays in
  files). The body should name its files so the model knows they exist:
  a standard footer line appended at render time when files exist —
  `Supporting files: reference.md, examples/… (use_skill({id, file}))`.
- **`use_skill` grows `file`:** `use_skill({id: "review", file:
  "reference.md"})` returns that file's content; `use_skill({id})`
  returns the body plus a file list. Unknown file → value-shaped error
  listing what exists. This is the chat thread's progressive
  disclosure: reference material loads on demand, one tool call.
- **Harness mounting maps files 1:1** through `HarnessV1Skill.files` —
  the adapters write them next to `SKILL.md` in the native dir, so a
  mounted skill is byte-identical for pi/claude/codex and the CLIs'
  own on-demand loading works on them.

### 3. Mount the catalog into harness calls

`buildHarnessAgent` gains `skills` from a new loader
(`lib/harness-skills.ts`): every ACTIVE skill in the catalog (thread
and reference alike), mapped to `HarnessV1Skill`:

- `name` = skill id, `description` = description, `content` = body with
  the same `{{owner}}` rendering and the files-footer as `use_skill`.
- `files` = the skill's files from `skill_files`.
- Loaded per harness call (fresh catalog read per call — edits apply to
  the next call without restart), passed via the existing
  `HarnessAgent` `skills` option. The adapter's manifest means a
  steady catalog writes nothing; an edit rewrites only changed files.
- Owner placeholders ARE rendered into mounted bodies (a harness
  reading "Chad" is correct; only the DB seed must stay owner-agnostic).
- Where they land: pi/codex `~/.agents/skills`, claude
  `~/.claude/skills` in the sandbox home — runtime-discovered, no
  prompt changes. Cursor: skipped entirely (adapter lacks the surface).
- **Cost guard:** mounted descriptions ride the harness's own startup
  context; bodies load on the runtime's demand. No per-turn token cost
  beyond what each CLI already spends on its skill listing.

### What deliberately does not change

- Thread binding semantics, budget, auto-continue (0039) — untouched.
- Skills remain global (no per-project grants — 2.3's grants idea stays
  parked; mounting everything active is simpler and the catalog is
  small and Chad-curated).
- `start_thread({skill})`, `?skill=`, pickers — untouched.
- The `.agents/skills` vendored dev-skill layer in this repo is dev
  container only, unrelated (it vendors AI Elements/SDK docs for
  harnesses working ON sweatshop; the mount writes into each project
  sandbox's home, no collision — different directory roots).
- No cron/scheduled skills (separate future work).

## Storage / migration

- `skill_files` table (migration 0090-ish, sequential number at write
  time). No backfill needed — existing skills have no files.
- `skills` rows unchanged; a version's files snapshot into
  `skill_versions` only on edit (versions keep full undo: body + files).

## Verification

- Unit: appendix rendering (active-only, cap, thread marker, empty
  catalog renders nothing); `use_skill` file reads (known, unknown,
  list-with-files); loader → `HarnessV1Skill` mapping (placeholders
  rendered, footer, files mapping, disabled/deleted excluded).
- Mock-model chat tests: instructions contain the appendix; harness
  call start passes skills (asserted on the built agent, no podman).
- Manual live: one pi call lists mounted skills in its own skill tool;
  claude discovers them in `/skills`-equivalent; edit a skill body,
  next call rewrites only that skill (manifest behavior).

## Changelog

User-visible: "Skills now reach pi, claude and codex inside sandboxes,
the skill list is visible to every chat, and skills can carry extra
reference files."
