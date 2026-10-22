# 0059 — Thread status: one mechanism for progress, skills as a log

> **Superseded by [0064](0064-outline.md)** — the outline replaced this mechanism (removed in 0064 PR 3).

Status: **approved in chat (2026-10-21).** Supersedes the progress parts
of 0041 (the "Building N/M" checklist count) and the stickiness of 0055
(one skill per thread, "this mode stays on"). Keeps 0055's mode skill
format, phase handoff, and work chips.

## Why

- "Building 0/N" is wrong almost always: `derivePhase` only re-counts on
  a `present_plan` snapshot, but boxes are ticked (if at all) by
  harnesses that never re-present. Progress lives in a file the agent has
  no reason to re-share.
- Phase (`mode_phase`) and plan progress are two parallel trackers for
  one question — "where is this thread?".
- Skills are, everywhere else (Claude Code, Codex), a tool call that adds
  context. Once loaded they are history; "sticky / can't turn off" is a
  warning about a lock that need not exist.

## Decisions

1. **Skills are a log.** `use_skill({id})` loads any active skill's body
   into the conversation as its tool result, any number of times, in any
   chat. Each load is an event in the transcript. There is no "leave":
   a newer skill or a newer status simply wins. The one-skill rule
   (`checkEnterMode`) and the "stays on" copy go. `enter_mode` goes too —
   loading a mode skill IS entering it; owner entry (`mode:` on a send /
   the chip) still appends the entry row.
2. **One status per thread, written by one tool.** `update_status`
   (every chat, always on) rewrites the whole status, TodoWrite-style:
   `{steps: [{label, state: pending|active|done|skipped|blocked,
   detail?, children?}], note?}`. A mode skill's declared phases seed the
   top-level steps; an approved plan's checklist becomes Implement's
   children. PLAN.md returns to prose-for-approval.
3. **Current status = the last `update_status` event** in the transcript;
   history = all of them. Derived, never stored (0041's philosophy). No
   new table. `mode_phase` is no longer the source of truth — the current
   phase is the active top-level step.
4. **Header label** comes from the status: `Implement · 2/6`, `Review`,
   `<step> · needs you` when a step is `blocked`. PR states still win
   (0052). Plan-in-review still shows `Plan vN · needs you`.
5. **Reliability by prompting at the right moments, honest when stale.**
   The per-turn `[thread state]` note shows the current status and asks
   for `update_status` if it changed; a wake carries the current step.
   A wake followed by a turn with no `update_status` marks the chip
   "stale" rather than showing a wrong count.
6. **Phase-tagged work stays** (`phase` arg on harness tools and
   `start_thread`), and its attached context becomes visible: a harness
   call stores the skill version + phase id so its card can re-render a
   collapsible "Phase context" block; a child shows the same block for
   its handoff first message.
7. **Children report up for free**: a child's own status appears in the
   parent's "Working now" list and its sidebar row; its final status
   rides its wake.
8. Guidance: `update_status` is for multi-step work only; a chat that
   never calls it shows no status chip.

## Not doing

Percentages, ETAs, owners per step, a status table, code gates on
phase order (advance rules become guidance in the skill markdown).
