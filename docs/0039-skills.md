# 0039 — Skills: playbooks fold in (and the delegation guard that follows)

Status: **2026-10-11 — direction approved by Chad in chat ("fold playbooks
into skills first, then add the delegate guard"); built on this branch.**
Supersedes the playbook *concept* of 0037 (the thread/delegation/gates
model is unchanged — only the packaging of the runbook changes) and
starts roadmap 2.3 (skills) with its thread half.

## Why

0037 made "playbook" a separate concept: a markdown runbook in
`docs/agent/playbooks/`, bound to a thread, with a raised budget and
auto-continue. Two days of use showed the concept earns nothing by being
separate:

- A playbook is prose — "advice, not enforcement" (0037's own words).
  What actually binds behavior is the tool layer (gates, evidence,
  child threads), which every chat already has.
- Run 8 ignored the playbook's delegation instruction (150 model steps,
  zero pi/claude calls) and other runs ignored stop rules. Prose does
  not gain power by having its own noun, loader, column and picker.
- Roadmap 2.3 (skills) was always going to need a directory of runbooks
  with a loader, grants and per-harness mounting. Two parallel systems
  (playbooks + future skills) is the sloppy-growth shape AGENTS.md
  forbids.

One concept: **a skill is a directory `skills/<id>/SKILL.md`** — front
matter `description`, H1 title, markdown body. A skill with
`thread: true` in its front matter is a **thread skill**: it can be
bound to a conversation as that thread's way of working. Binding puts
the body in the turn instructions and raises the step budget (50 → 400)
with bounded auto-continue — exactly the old playbook semantics, now
declared by the skill instead of by a parallel system.

## What changes (v1, this PR)

- `skills/{ship,ticket,review}/SKILL.md` — the three playbooks move,
  unchanged in substance, gaining `thread: true`. Their prose now says
  "skill". `docs/agent/playbooks/` is deleted.
- `lib/skills.ts` (from `lib/playbooks.ts`): `readSkill` / `listSkills`
  / `listThreadSkills`; `thread` parsed from front matter. Read at call
  time from the app's checkout, like `system_docs`.
- The bindable thing is a **thread skill** — a skill without
  `thread: true` can live in the directory (reference material for
  later 2.3 work) without appearing in pickers or being bindable.
- Naming, everywhere: UI word **skill**; tool `use_playbook` →
  **`use_skill`**; `start_thread({skill?})`; `?skill=` on `/`;
  `POST /api/x/chat {skill}`; `GET /api/skills`; the composer picker
  section "Chat with a skill".
- Storage: `conversations.playbook` → **`conversations.skill`**
  (migration 0048 renames the column; existing `ship`/`ticket`/`review`
  values carry over). The budget `runEvent` kind stays `"budget"` —
  it names a cause, not the concept.
- `PLAYBOOK_MAX_STEPS` → `THREAD_SKILL_MAX_STEPS`; the wake's thread
  name and the child-status field read the skill id.
- Docs: AGENTS.md's playbook bullet becomes the skills bullet; ROADMAP
  2.3 notes the fold. 0037 and older docs stay historical.

Not in v1 (deliberately): grants, per-harness mounting into sandboxes,
editing skills through agent tools — the rest of 2.3, now building on
one concept instead of two. The vendored dev skills (`.agents/skills`,
`skills-lock.json`) are untouched: they serve harnesses' own skill
conventions and join `skills/` when mounting lands.

## Phase 2 — the delegation guard (next PR, after this merges)

The one playbook instruction prose keeps losing: "delegate non-trivial
edits to a harness" (run 8: all edits done by the thread itself). A
runtime guard, not more prose:

- In a **thread-skill turn**, the bash tool step tallies estimated
  file-mutation volume for the turn (write-shaped commands: `>`/`>>`
  redirects, heredocs into files, `tee`, `sed -i`, `patch`, `cp`/`mv`
  onto tracked paths). Reads never count.
- Over a per-turn allowance (constant first; per-skill front matter
  later if it earns it), the bash tool returns a **value-shaped error**:
  the command did not run, delegate the remaining edits to `pi`,
  `claude` or `cursor` with a precise task (files, change, acceptance
  check). The model repairs by delegating — the same pattern as every
  other value-shaped tool failure.
- Plain chats are untouched; the guard is the price of the 400-step
  leash, where doing all edits yourself is the failure mode.
- Honest limits, recorded here: the tally is a heuristic on command
  text. It will miscount occasionally in both directions; the guard
  errs toward counting (the escape is delegating, which is the goal).
  Mock-model tests pin: under the allowance nothing changes; over it
  the error is value-shaped and the command did not run.

## Verification for v1

- Loader tests (`tests/skills.test.ts`, from `playbooks.test.ts`):
  front matter (description, `thread`), H1 titles, listing, unknown id
  rejected, non-thread skills excluded from the thread catalog.
- The existing x-chat / chat-tools / start-thread / wake /
  child-status suites move to the new names (tool `use_skill`, param
  `skill`, column `skill`) and keep asserting the same behavior.
- Migration: column renamed, values intact (`ship`/`ticket`/`review`
  threads keep their skill).
