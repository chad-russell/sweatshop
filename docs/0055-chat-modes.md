# 0055 — Ticket mode: one sticky mode, a phase, and a calmer chat chrome

Status: **Approved by the owner (plan v5, chat 2026-10-20).** v5 applies an
adversarial "overengineered" review (thread c_tmvhjmxkf38ccdb74bc76):
the thread-state subsystem is cut to one column; most gates, the form
card, snapshots and the reserved settings slot are deferred to 0056 or
dropped. 0056 (launcher, per-phase routes, `run_phase`) builds on this.

## Why

Thread skills (0039) are ambiguous: `ship` and `ticket` overlap; the
base prompt lets the agent bind one silently mid-chat; once running,
nothing on screen says a thread runs one or what that means (system-
prompt runbook, 50 → 400 steps, auto-continuation). The header has five
controls beside the crumbs.

## Decisions (owner, in chat 2026-10-20)

- Normal chat is the default; **ticket is the only mode**. Review is a
  phase in it, or ad hoc — never a mode.
- Entering is **explicit** (owner, or agent proposes + owner approves)
  and **sticky** for the rest of the chat.
- Plan approval and iteration stay a human gate.
- Entering never changes the system prompt (append-only; cache holds).
- The model sees thread state (mode + phase), re-injected each turn;
  the agent declares phases, code checks them.

## Normal chat vs ticket mode

| | Normal chat | Ticket mode |
|---|---|---|
| Who does the work | The agent; harnesses per base steering or when asked | The agent orchestrates; each phase runs in a harness call or child thread |
| Plan | Optional | `PLAN.md` + `present_plan`, owner approves (0041) |
| Fresh-eyes review | If asked | Always, before `create_pr` |
| Step budget | 50 | 400 + continuation (≤ 3) |
| Phase | — | `plan → implement → review → fixup → ship` |

Ticket mode needs a project; elsewhere the chip is absent and
`enter_mode` refuses value-shaped.

## Mechanism

**State = two columns, one of them existing.**
- `conversations.skill = "ticket"` IS the mode (write-once, never
  cleared → sticky by construction). Budget, continuation and
  `inspect` keep working through today's `resolveMaxSteps` /
  `loadSkillStep` unchanged.
- New `conversations.mode_phase` (text, null). Set to `plan` on entry.
- No new tables. The audit trail is the transcript: every
  `advance_phase` and entry is already a row in `messages`.

**`lib/modes.ts` (~60 lines)** — the mode as code: ticket's skill id,
phase order, transition rule (forward one step, `review → ship` when
the review is clean, the `fixup ⇄ review` loop, backward any step with
a note), and `##`-section extraction from the runbook. **One gate:**
`implement` requires the latest plan row to be
approved — a single sqlite read of `pending_inputs`, and the one human
gate the owner named. No sandbox/git gates; "is there anything to
review" stays runbook prose (a review child on an empty diff says so).
*Design note:* 0041 chose no hard gate on `create_pr`; this does not
change that — it gates the agent's own phase claim, not a tool.

**Tools.**
- `enter_mode({mode: "ticket", ticket, reason})` — the agent drafts the
  ticket; the tool asks through the existing `ask_owner`-style approval
  card (card shows the draft + reason). Approve → writes skill +
  phase and returns the runbook's intro + `plan` section; deny →
  comment returned, nothing changes. Refuses without a project or when
  already moded. No new card kind.
- `advance_phase({to, note})` — validated by `lib/modes.ts`; refusal
  names the rule (`"implement needs an approved plan — present_plan
  first"`); success writes the column and returns that phase's `##`
  section (just-in-time runbook).
- `use_skill` becomes list-only. Binding happens only at the creating
  send, via `enter_mode`, or by `start_thread` for children.

**Owner entry.** The mode chip's "Ticket mode" (and the fresh composer
via `?mode=ticket`; `?skill=ticket` still works) marks the NEXT send:
that send writes skill + phase and is followed by a `runEvent: "mode"`
row carrying the runbook intro + `plan` section — appended, never in
the system prompt. The ticket key rides the message text (today's
convention). No form in 0055 — 0056's launcher is the form, when it has
per-phase routes to collect.

**Instructions.** `buildInstructions` skips a skill that is a mode
(by `lib/modes.ts`) **when `mode_phase` is set** — legacy threads bound
to `ticket` before 0055 (null phase) keep today's system-prompt
behavior, untouched. Non-mode skills (`review` children) unchanged.
Edits to the ticket skill in `/settings` reach every ticket chat on its
next phase advance (sections are read current, per 0054); no snapshots.

**Per-turn reminder.** On the existing "[viewing]" note path (rebuilt
each turn, metadata-borne, never persisted, rides the end of the
request so the cached prefix holds), mode chats get:

```
[thread state] mode: ticket · phase: implement (2/5) · next: review
```

Normal chats get nothing. The base prompt gains one fixed line:
"If a `[thread state]` note is present, honor its mode and phase."
Mid-turn phase changes reach the model via `advance_phase`'s own
result, so per-call injection isn't needed.

**Base prompt.** The "bind ship or ticket with use_skill" paragraph
becomes: the mode is the owner's; suggest ticket mode with
`enter_mode` (once) when work needs a plan or a PR; honor the thread
state note. Shipped as a new `git` version only if the row is still the
unedited default (#136's exact-match idiom); an edited base is left
alone.

**Skills.** `skills/ticket` rewritten orchestrator-shaped: a short
intro + one `##` section per phase id. `ship` retired (a seeded
`disabled` version — restorable). `review` unchanged.

## Chrome

```
[🎫 Ticket · implement ▾]  [model ▾]  [sandbox ▾]  [hosts]      ◔ 42% · $0.31   [↑]
```

- **Mode chip** (left-most, project chats only): "Normal ▾" → "Ticket
  mode" with a two-line meaning; in ticket mode a tinted chip with the
  phase, whose menu lists the five phases (current marked) and says it
  is permanent for this chat. No live gate status. Replaces the skill
  half of `FreshTargetPicker`.
- **Usage control:** the 0051 meter and 0047 cost merged into one
  composer-bar button opening the stats content, context first. Tones
  unchanged; hidden until metered.
- **Header:** crumbs · phase chip (0041 derived, unchanged, all chats —
  richer than five fixed phases) · preview pill · extras.
- Narrow: usage → ring only; mode chip → icon + phase.

## Deferred to 0056 (or until evidence)

Ticket form/launcher, per-phase routes and a `settings` column,
`run_phase`, phase strip, more gates, a `skills.mode` data flag (only
when a second mode exists), runbook snapshots.

## Build steps

PR 1 — mode + phase:
- [ ] `conversations.mode_phase` migration; `lib/modes.ts` (order,
      transitions, plan gate, section extraction).
- [ ] Rewrite `skills/ticket` (intro + phase sections); retire `ship`.
- [ ] `enter_mode`, `advance_phase`; `use_skill` list-only;
      `buildInstructions` mode skip (phase set only).
- [ ] Owner entry (send flag, `?mode=`) + `runEvent: "mode"` row/chip.
- [ ] `[thread state]` per-turn note; base prompt paragraph + fixed
      line, guarded upgrade.
- [ ] Tests: transitions + plan gate, enter_mode approve/deny/refusals,
      stickiness, system prompt identical before/after entry, legacy
      ticket threads unchanged, note present/absent, use_skill no
      longer binds.

PR 2 — chrome:
- [ ] Mode chip + phase menu; picker loses the skill axis.
- [ ] Usage control in the composer bar; header loses stats/context.
- [ ] Before/after screenshots (desktop + narrow).
- [ ] AGENTS.md + docs/agent.
