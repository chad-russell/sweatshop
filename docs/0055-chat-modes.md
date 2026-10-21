# 0055 — Ticket mode: one explicit, sticky mode, and a calmer chat chrome

Status: **Draft v2 — awaiting the owner's approval.** Phase C (the
ticket launcher, `run_phase`, per-phase routes) gets its own doc, 0056,
after this one lands.

## Why

Thread skills (0039) are the only "mode" a chat has today, and they are
ambiguous in three ways:

1. **Which one, and when.** `ship` and `ticket` overlap (ticket = ship +
   plan gate + review). The base prompt tells the agent to bind one
   *itself* on "ship it" / "do this ticket", so a thread can silently
   change behavior mid-conversation.
2. **Invisible once running.** The fresh-composer picker shows the skill
   before the first send; after that nothing on screen says the thread
   runs one (only a `use_skill` card buried in the transcript).
3. **Unclear meaning.** "Attached" means: the body joins the system
   prompt every turn, the step budget rises 50 → 400, and an exhausted
   turn auto-continues (≤ 3). None of that is said anywhere.

Meanwhile the header has grown five controls (phase chip, stats drawer,
context meter, preview pill, extras) beside the crumbs.

## Decisions (owner, in chat 2026-10-20)

- **Normal chat is the default — no mode applied.** No "Quick" mode: a
  plain chat already is quick.
- **Ticket mode is the only mode** (for now). Review is a phase inside
  it, and ad hoc ("please review this") in any chat — never a mode.
- **Entering is explicit**: the owner picks it, or the agent PROPOSES it
  and the owner approves. Never silent.
- **Sticky**: once a chat is in ticket mode it stays in it for the rest
  of the chat. No exit, no switching between modes.
- Plan approval (and iteration on it) stays a human gate in ticket mode.

## What ticket mode is

| | Normal chat (default) | Ticket mode |
|---|---|---|
| Who does the work | The agent itself; harnesses when the base steering says (non-trivial edits) or the owner asks | The agent ORCHESTRATES; every phase runs in a harness call or child thread |
| Plan | Optional | `PLAN.md` + `present_plan`, owner approves (0041 gate, unchanged) |
| Fresh-eyes review | Only if asked | Always, before `create_pr` |
| Step budget | 50 | 400 + budget continuation (≤ 3) |
| `create_pr` | Available, approval-gated as always | The required end of the run |
| Context goal | n/a | Orchestrator stays small: it holds the plan and the handles, never the diffs |

Ticket mode needs a project (sandbox + repos); a plain chat cannot enter
it — the control is absent, and the tool refuses value-shaped.

### Mechanism: a mode is a flagged thread skill

No new runbook mechanism:

- `skills/ticket/SKILL.md` is rewritten orchestrator-shaped (plan via a
  harness or child → owner approval → implement via a harness → QA via a
  `review` child → fix-up loop → ship) and gains `mode: true` in front
  matter + a `skills.mode` column (versioned like every field, 0054).
  Editable in `/settings` like any skill.
- `ship` is **retired**: a seeded `disabled` version (restorable — 0054
  never hard-deletes); threads already bound to it keep reading it.
- `review` stays a non-mode thread skill, bindable only by
  `start_thread` for children.
- `conversations.skill` stays the one column; a derived read-model field
  `mode: {id, title} | null` is the bound skill when it has `mode: true`.
- `use_skill` stops binding: it only lists reference skills. Binding a
  thread happens through exactly two paths — the creating send, and
  `enter_mode` below. Since `conversations.skill` is written once and
  never cleared, stickiness holds by construction (a second
  `enter_mode` in a moded chat refuses: "already in ticket mode").

### Entering mid-chat: `enter_mode`

- **Owner:** the composer's mode chip → "Switch to ticket mode". Takes
  effect on the next send (it is a send-time flag, like `?skill=` today,
  so no turn is interrupted).
- **Agent:** a new tool `enter_mode({mode: "ticket", reason})`,
  approval-gated like `create_pr` (0034 A). The card says what changes
  (the table above, in two lines) and the agent's reason. Approve →
  bound, the runbook comes back as the tool result so the agent follows
  it from this turn; deny → the comment returns, nothing changes. The
  base prompt tells the agent: when work grows past a quick change
  (multiple files, needs a plan, wants a PR), suggest ticket mode with
  `enter_mode` — once, not repeatedly.

**Prompt caching:** entering costs ONE cache miss, at the next turn,
when the runbook joins the system prompt (the entering turn itself only
appends a tool result, which the cache keeps). Since entry is one-way
and once per chat, that is the whole cost — no contradictory runbooks,
no re-swaps. This is why sticky beats switchable.

### Base prompt

The "bind ship or ticket with use_skill" paragraph becomes: the chat's
mode is visible to the owner and changes only by their choice; suggest
ticket mode via `enter_mode` when warranted. Upgraded through the 0054
store as a new `git` version only when the current row is still the
unedited git default (the #136 exact-match idiom); an owner-edited base
is left alone and `/settings` notes "a newer default is available".

## Chrome: one composer bar, a calmer header

### Composer bar (bottom)

```
[🎫 Ticket ▾]  [model ▾]  [sandbox ▾]  [hosts toggle]        ◔ 42% · $0.31   [↑]
```

- **Mode chip** (new, left-most, project chats only). Normal chat: a
  quiet "Normal ▾" whose menu has "Ticket mode" with its two-line
  meaning. In ticket mode: a tinted "Ticket" chip whose menu restates
  what the mode does and that it is permanent for this chat; no
  exit item. Replaces the skill half of `FreshTargetPicker` (which keeps
  only Chat / project); `?skill=ticket` keeps working, `?mode=ticket`
  is the new spelling.
- **Usage control** (moved from the header, merged): the 0051 ring +
  percentage and the 0047 cost as one button; clicking opens the stats
  drawer content as a popover/sheet, context breakdown first. Warn tones
  unchanged (85 / 95). Hidden until metered.

### Header (top)

Crumbs · phase chip (0041/0052, unchanged — 0056 grows it into the
ticket phase strip) · preview pill · extras. Stats and context leave the
header.

Narrow viewports: the usage control collapses to the ring; the mode chip
to its icon.

## Not in this doc (0056, Phase C)

The ticket launcher (a form instead of the textarea: per-phase
harness/model/effort, presets), `run_phase(phase, task)` enforcing those
routes, per-thread harness routes (today claude/cursor/codex resolve
globally only — `resolveRoute`), and the header phase strip. 0055's
ticket runbook uses whatever routes resolve today.

## Build steps

- [ ] `skills.mode` column + front matter, migration, versioned; read-
      model `mode`.
- [ ] Rewrite `skills/ticket` (orchestrator, `mode: true`); retire `ship`
      (disabled version); `review` unchanged.
- [ ] `use_skill` list-only; `enter_mode` tool (approval-gated card,
      refuses without a project / when already moded); `resolveMaxSteps`
      unchanged (any bound skill → 400).
- [ ] Owner entry from the mode chip (send-time flag); `?mode=` alias.
- [ ] Base prompt paragraph rewrite + guarded upgrade of unedited rows.
- [ ] Mode chip; `FreshTargetPicker` loses the skill axis.
- [ ] Usage control in the composer bar; header loses stats/context.
- [ ] Tests: flag + read model, `use_skill` no longer binds, `enter_mode`
      approve/deny/refusals, stickiness, owner entry; before/after
      screenshots of header + composer.
- [ ] AGENTS.md Skills bullet + docs/agent updated.
