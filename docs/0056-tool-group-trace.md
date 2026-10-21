# 0056 — Trace steps inside tool groups

Status: **approved in chat (2026-10-20); implemented on
`fix/tool-call-full-width`.** Keep the current box and use shadcn Trace
for its expanded contents.

## Design

- Keep the full-width, collapsible group shell and its compact summary.
- Vendor the Radix shadcn Trace primitives, adapted to the existing
  `Collapsible`, Lucide icons, and semantic theme tokens. No new dependency.
- Each call is a trace step: status icon, action label first, tool name
  secondary, repeat count where applicable. Keyboard-accessible expansion
  reveals the existing specialized card along a subtle vertical guide.
- Remove the nested card's outer border/shadow in this context only; retain
  its controls, terminal styling, and output. Approvals and other loud
  tools stay outside quiet groups, as before.
- Keep failures red at the individual step. The group describes activity,
  not task success: running work stays blue; a settled group with failed
  calls gets an amber “completed · N failed calls” summary rather than a
  red failed state. Do not infer that a later successful call fixed one.
- Keep the existing allow-list, repeated-poll folding, stable row keys,
  and persisted transcript unchanged. No reasoning text or invented timing.

## Checks

Test status presentation for running, completed, and mixed-failure groups,
and test Trace rendering/accessibility with the existing React/Vitest stack.
Visually check expanded content, narrow widths, failure emphasis, and
keyboard interaction. Run the container typecheck, lint, and test gates
before committing.

Reference: https://ui.shadcn.com/docs/components/radix/trace

## Verification

The component fixture exercises the real ToolGroupView, Trace, and
specialized cards, without changing the running app. Checked at desktop,
375 px, and 320 px in cal/clickhouse: fixed box width through status
changes, repeated polls, keyboard Enter/Space expansion, focus rings,
and borderless nested terminal details. Small headers wrap their status
under the summary rather than crowding it.

The browser accessibility audit caught reduced contrast in upstream
TraceDescription's opacity; use the full muted-foreground token instead.
The existing terminal's `text-terminal-muted` bash label still has a
4.34:1 contrast ratio in clickhouse (outside this change's trace styling).
