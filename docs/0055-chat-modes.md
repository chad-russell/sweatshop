# 0055 — Modes: owner-defined, sticky, phased skills

Status: **Approved by the owner (plan v7, 2026-10-21).** Supersedes approved v5
(owner feedback 2026-10-21: modes and phases are defined freely in
Settings, not in code). History: v1–v5 in this doc's git log; the
overengineering review (thread c_tmvhjmxkf38ccdb74bc76) still applies —
no new tables, no code gates. 0056 (per-phase harness/model, launcher)
builds on this.

## Why

Thread skills (0039) are ambiguous: `ship` and `ticket` overlap, the
agent can bind one silently mid-chat, and once running nothing on
screen says what a thread is doing or who is working on what. Rigid
workflow definitions (Zapier-style) failed before; prose the agent
interprets works. So: give the owner a light, freeform way to describe
a staged way of working, make it visible, and keep the code's share of
structure minimal.

## Decisions (owner)

- Normal chat is the default. A **mode** is an explicit, sticky way of
  working, entered by the owner or by the agent with the owner's
  approval; it lasts the rest of the chat.
- Modes are **defined in skill markdown**, freely: create, redefine,
  disable, delete in `/settings`. `ticket` ships as the one default.
- **Phases are declared in the markdown**; each phase is typically
  carried out by a harness or child thread, and the UI shows which
  phase each piece of live work is doing.
- Entering a mode never changes the system prompt (cache holds); a
  per-turn `[thread state]` note carries mode + phase.
- Plan approval stays a human gate (the 0041 card), not a code gate.

## Mode skill format

```markdown
---
description: Planned work to an approved PR.
mode: true
---
# Ticket

Orchestrator brief: how to run this mode — delegate each phase, keep
your own context small, wait for plan approval, etc.

## Shared
Context every phase worker gets: conventions, branch naming, how to
verify, what "done" means.

## Phase: Plan
...
## Phase: Implement
...
## Phase: QA
...
```

Three keys, all plain markdown:

| Key | Meaning |
|---|---|
| `mode: true` (front matter) | This skill is a mode. Without it, a skill is an ordinary skill, whatever its headings. Implies `thread: true`. Stored as a versioned `skills.mode` field; Settings shows it as a checkbox beside "thread". |
| `## Phase: <Name>` | One phase, in document order. Name is free text ("QA", "Write docs"); its id is the slug (`qa`, `write-docs`). The section runs to the next `##`. `###` and deeper inside a phase are just content. |
| `## Shared` (optional) | Prepended to every phase handoff. |

Everything else — the H1, the text before the first `##`, any other
`##` section — is the **orchestrator brief**: read only by the thread
running the mode. A mode with no `## Phase:` headings is valid: a
sticky runbook with no phases (no phase chip, `advance_phase` refuses
value-shaped). Nothing is validated on save; Settings shows the parsed
result live under the editor (mode yes/no, phase list, whether Shared
is present) so the owner sees what the agent will see.

## Who reads what

| Reader | Gets |
|---|---|
| **Orchestrator, on entry** (appended row / `enter_mode` result) | brief + phase list + Shared + first phase section |
| **Orchestrator, on `advance_phase`** (tool result) | that phase's section (it already has the brief in history) |
| **Phase worker** (harness call or child thread started in a moded chat) | handoff block (below) + the orchestrator's task |
| **Model, every turn** | `[thread state] mode: ticket · phase: qa (3/5) · next: ship` |

**Phase handoff — runtime-attached, not paraphrased.** When the
orchestrator starts a harness (`pi`/`claude`/`cursor`/`codex`) or
`start_thread` child in a moded chat, the runtime prepends:

```
You are doing the "QA" phase of a "Ticket" run. Do only this phase;
other phases are handled separately. Your result goes back to the
orchestrator.

<Shared section>

<QA phase section>

---
Task from the orchestrator:
<the task it wrote>
```

The orchestrator writes only the task-specific part (what changed, the
branch, where evidence is). Why this shape:

- **Not the phase section alone** — the worker lacks shared conventions
  (branch naming, test command, verification standard), and every
  phase would have to repeat them.
- **Not the whole skill** — the brief is addressed to the orchestrator
  ("delegate", "advance_phase", "wait for approval"); a worker reading
  it may delegate again or wander into other phases (an implementer
  opening the PR). Other phases' text is also wasted context.
- **Runtime-attached, not left to the orchestrator** — the handoff is
  then exactly what the owner wrote, every time, and the orchestrator's
  prompt stays short. The card shows the orchestrator's own task plus
  the phase label; the full handoff lives only in the worker's prompt.

The phase defaults to the chat's current phase; the tools gain an
optional `phase` arg for work outside it (e.g. a QA child spawned while
still in implement). A child thread that also binds a skill (`review`)
gets both: its skill in its system prompt, the handoff in its prompt.
Phase sections are written for **whoever does the phase** — the
orchestrator may do a phase itself (e.g. Ship needs `create_pr`, which
harnesses don't have); the brief says which.

## Mechanism

- **State:** `conversations.skill` = the mode's skill id (write-once →
  sticky); `conversations.mode_phase` = current phase id. Harness calls
  and child threads record `phase` (`harness_calls.phase`, child
  `conversations.mode_phase`-style label) at start.
- **`lib/modes.ts`:** parse a skill body → `{brief, shared, phases[]}`;
  `isMode(skill)` reads the flag; `threadStateNote`; `phaseHandoff`.
  No hardcoded mode or phase ids.
- **`enter_mode({mode, ticket, reason})`:** any active mode skill;
  approval-gated via the existing card; project chats only; refuses
  when already moded. Owner entry: the mode chip / `?mode=<id>` on a
  send. Disabled modes can't be entered; chats already in them continue.
- **`advance_phase({to, note?})`:** `to` must be a phase the CURRENT
  body declares (unknown → refusal listing the declared ones, so a
  renamed heading degrades to a clear message). Moving to the next
  phase needs no note; anything else (back, skip, loop) needs one. No
  gates. Legacy threads (bound before 0055, no phase) adopt with a note.
- **`use_skill`** is list-only. **`buildInstructions`** skips a mode
  skill once its phase is set; legacy and non-mode skills unchanged.
- **Base prompt:** the mode is the owner's; suggest one with
  `enter_mode` (once) when work needs it; honor the `[thread state]`
  note. Guarded upgrade of the unedited default only.
- **Skills:** `ticket` rewritten to this format (brief, Shared, phases
  Plan / Implement / Review / Fixup / Ship); `ship` retired (disabled
  version); `review` unchanged.

## Chrome (PR 2)

```
[🎫 Ticket · QA · 2 working ▾]  [model ▾]  [sandbox ▾]  [hosts]      ◔ 42% · $0.31   [↑]
```

- **Mode chip:** "Normal ▾" → lists active modes with descriptions. In
  a mode: mode · phase · "N working"; the menu shows the phase list
  (current marked) and live work (phase · harness · status · link),
  from the existing `useChildStatus` poll.
- **Work chips:** harness/thread cards and their sidebar rows show
  `QA · cursor`.
- **Usage control:** the 0051 meter and 0047 cost merged into one
  composer-bar button. Header: crumbs · phase chip (0041) · previews.

## Deferred to 0056

Per-phase harness/model/effort (likely an optional line under each
`## Phase:` heading, e.g. `harness: cursor`, plus the launcher UI),
`run_phase`, presets.

## Build steps

PR 1 (amend #137):
- [ ] `skills.mode` versioned field + front matter + Settings checkbox;
      parser (`brief`/`shared`/`phases`) with live Settings preview.
- [ ] Drop hardcoded phases/transitions/plan gate; free `advance_phase`
      over declared phases; enter any active mode; legacy adoption.
- [ ] Phase handoff prepended to harness tasks and child prompts;
      `phase` recorded on harness calls and children; optional `phase`
      arg.
- [ ] Rewrite `skills/ticket` in the new format; keep `ship` retired.
- [ ] Tests: parser (no phases, Shared absent, `###` inside, odd names),
      flag gating, advance over declared phases + refusals, handoff
      content (no brief, no other phases), disabled mode entry refused,
      cache stability, legacy.

PR 2 — chrome:
- [ ] Mode chip + menu with live work; work chips on cards and sidebar.
- [ ] Usage control in the composer bar; header slimmed.
- [ ] Before/after screenshots; AGENTS.md + docs/agent.
