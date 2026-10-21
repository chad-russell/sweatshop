# 0055 — Chat modes: Quick and Full ticket, and a calmer chat chrome

Status: **Draft — awaiting the owner's approval.** Phase C (the Full
ticket launcher, `run_phase`, per-phase routes) gets its own doc, 0056,
after this one lands.

## Why

Thread skills (0039) are the only "mode" a chat has today, and they are
ambiguous in three ways:

1. **Which one, and when.** `ship` and `ticket` overlap (ticket = ship +
   plan gate + review). The owner can't tell when to pick which; the base
   prompt tells the agent to bind one *itself* on "ship it" / "do this
   ticket", so a thread can silently change behavior mid-conversation.
2. **Invisible once running.** The fresh-composer picker shows the skill
   before the first send; after that nothing on screen says the thread
   runs one (only a `use_skill` card buried in the transcript).
3. **Unclear meaning.** "Attached" means: the body is appended to the
   system prompt every turn, the step budget rises 50 → 400, and an
   exhausted turn auto-continues (≤ 3). None of that is said anywhere.

Meanwhile the header has grown five controls (phase chip, stats drawer,
context meter, preview pill, extras) beside the crumbs.

## Decisions (owner, in chat 2026-10-20)

- Two user-facing modes: **Quick** and **Full ticket**. Review is NOT a
  mode — it is a phase inside Full ticket, and ad hoc ("please review
  this") in any thread.
- Plan approval (and iteration on it) stays a human gate in Full ticket.
- Mode switching must not break prompt caching — see "Switching".

## Modes

A **mode** is a property of the thread, chosen at the creating send,
shown at all times, and changed only by the owner.

| | Quick | Full ticket |
|---|---|---|
| Who does the work | The top-level agent itself (bash edits, its own checks) | The top-level agent ORCHESTRATES; every phase runs in a harness call or child thread |
| Harness / subagent use | Only when the owner explicitly asks | Always: plan, implement, QA/review, fix-up |
| Plan | None (it may sketch one in its reply) | `PLAN.md` + `present_plan`, owner approves (unchanged 0041 gate) |
| Fresh-eyes review | Only if asked | Always, before `create_pr` |
| Step budget | 50 (today's plain chat) | 400 + budget continuation (today's thread-skill budget) |
| `create_pr` | Available, approval-gated as always | Required end of the run |
| Context goal | n/a | Keep the orchestrator small: it holds the plan and the handles, never the diffs |

**Default:** a project chat starts in Quick; a plain (non-project) chat
has no mode (no chip, no picker — modes only mean something with a
sandbox and repos).

### Implementation: modes are skills with a flag

No new runbook mechanism. A mode is a thread skill with `mode: true` in
its front matter / catalog row:

- `skills/quick/SKILL.md` (new) and `skills/full-ticket/SKILL.md`
  (rewritten from `ticket`, orchestrator-shaped: plan via a harness or
  child, implement via a harness, QA via a `review` child, fix-up loop,
  ship). Both editable in `/settings` like any skill (0054).
- `ship` and `ticket` are **retired**: status `disabled` via a seeded
  version (restorable — 0054 never hard-deletes), so existing threads
  bound to them keep reading their current body.
- `review` stays a thread skill but `mode: false` — bindable by
  `start_thread` (the agent's tool), never shown in the mode picker.
- `conversations.skill` stays the one column. A new derived read-model
  field `mode: {id, title} | null` = the bound skill when it has
  `mode: true`.
- Budget: `resolveMaxSteps` keys off the skill's flag rather than "any
  skill" — Quick gets 50, Full ticket 400. (A `budget: "thread"` front-
  matter key on the skill, default thread for non-mode skills, so
  `review` children keep 400.)

### The agent can no longer self-bind a mode

- `use_skill` keeps *listing* skills (reference material) but **binding
  refuses mode skills** value-shaped: `"modes are chosen by {{owner}} —
  ask them, or suggest starting a Full ticket thread"`.
- The base prompt's "bind ship or ticket" paragraph is replaced with:
  the thread's mode is shown to the owner and set by them; if the work
  outgrows Quick, say so and suggest a Full ticket thread.
- Base section changes go through the 0054 store as a new `git` version
  only when the current row is still the unedited git default
  (same exact-match repair idiom as #136); an owner-edited base is left
  alone and the Settings page flags "a newer default is available".

## Switching

Appending "you are now in mode X" mid-thread keeps the cache warm only
if the old mode's runbook stays in the system prompt — so the model
reads two contradicting runbooks, the newer one in a user-role message.
Swapping the system prompt instead invalidates the whole cache.

**Decision for this doc: switching = a new thread with a handoff.**
The mode chip's menu offers "Continue in Full ticket →", which:

1. creates a new conversation in the SAME project, attached to the SAME
   sandbox and work dir (0013 attach — the checkout, branch and any
   `PLAN.md` carry over for free),
2. records a new `continued_from` column — deliberately NOT
   `parent_conversation_id`: the new thread is a sibling, never wakes
   the old one, and is its own root in the sidebar,
3. prefills the composer with a handoff the owner can edit: the old
   thread's title + summary (0007), the branch, and the last assistant
   report, clipped.

The old thread gets a transcript chip "Continued in <title> →". Cheap,
cache-safe, explicit. Revisit an in-place switch only if this proves
annoying in practice.

## Chrome: one status strip, one composer bar

### Composer bar (bottom)

```
[⚡ Quick ▾]  [model ▾]  [sandbox ▾]  [hosts toggle]        ◔ 42% · $0.31   [↑]
```

- **Mode chip** (new, left-most): icon + mode name. Before the first
  send it is the picker (Quick / Full ticket, each with a one-line
  description of what it means — the three facts in "Unclear meaning"
  above). After: a menu showing what the mode does and "Continue in
  <other mode> →". Replaces the skill half of `FreshTargetPicker`
  (which keeps only Chat / project).
- **Usage control** (moved from the header, merged): the 0051 ring +
  percentage and the 0047 cost, one button. Click opens the existing
  stats drawer content as a popover/sheet with the context breakdown at
  the top. Warn tones unchanged (85 / 95). Hidden until metered.

### Header (top)

Crumbs · **phase chip** (0041/0052, unchanged — in Full ticket it
becomes the phase strip in 0056) · preview pill · extras. Stats and
context leave the header.

Narrow viewports: the usage control collapses to the ring only; the
mode chip to its icon.

## Not in this doc (0056, Phase C)

The Full ticket launcher (form instead of the textarea, per-phase
harness/model/effort, presets), `run_phase(phase, task)` enforcing the
chosen routes, per-thread harness routes (today claude/cursor/codex are
global-only — `resolveRoute`), and the header phase strip. 0055's
`full-ticket` skill uses whatever routes resolve today; 0056 makes them
per-phase.

## Build steps

- [ ] `mode` / `budget` skill metadata (front matter + `skills` columns,
      migration, versioned like every field), read-model `mode`.
- [ ] `skills/quick`, `skills/full-ticket`; retire `ship`/`ticket`
      (disabled version); `review` unchanged.
- [ ] `use_skill` refuses mode skills; `resolveMaxSteps` per skill.
- [ ] Base prompt paragraph rewrite + guarded upgrade of unedited rows.
- [ ] Mode chip (fresh picker + running menu); `FreshTargetPicker`
      loses the skill axis; `?skill=` → `?mode=` (old param still works).
- [ ] Usage control in the composer bar; header loses stats/context.
- [ ] "Continue in …" handoff: `continued_from`, attached sandbox,
      prefilled composer, transcript chip.
- [ ] Tests: catalog flags, binding refusal, budget, handoff, read
      model; screenshots before/after of header + composer.
- [ ] AGENTS.md Skills bullet + docs/agent updated.

## Open questions

1. Quick in a project chat as the default — or should the picker
   remember the last mode per project?
2. Should Quick still require the fresh-eyes review before `create_pr`
   if it opens one (today's base prompt says "real ticket work" gets
   one)? Proposed: no — Quick means Quick.
