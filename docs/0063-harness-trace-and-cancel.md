# 0063 — Harness session view: shared tool grouping, and a cancel button

Status: **approved in chat (plan v1, 2026-10-21); implemented on
`glen/harness-trace-cancel`.**

## Problem

1. The harness session pages (`/h/<harness>/<session>[/<call>]`) rendered one
   full card per tool call. The main chat folds quiet, read-only calls with
   `groupParts` + `ToolGroupView` (0056); the two renderers never met, so a
   Claude/Codex/Cursor/pi session read as a wall of identical cards.
2. Cancelling a background harness call existed only as the agent's
   `cancel_run` tool — no button on the session page or the chat's harness card
   — and a cancelled session showed the green "success" tone.

## Design

- **One grouping path.** `HarnessEventLog` folds the raw events with
  `buildTimeline`, converts them with `timelineToParts` (1:1 with the timeline
  items; every non-tool item becomes a non-empty text part so it ends a run,
  exactly like prose in chat) and renders `groupParts(parts)`. A group is the
  same `ToolGroupView`; its `render` callback draws the harness's own specialised
  card (`HarnessToolCall`). One allow-list (`QUIET_TOOLS`) now serves chat and
  every harness: `read`/`grep`/`glob`/`find`/`ls` joined `bash`. `write`/`edit`
  stay loud (they change things; their file-change chips remain).
- **Tool names.** Prod `harness_events` (sampled read-only, 2026-10-21) already
  carry the same lowercase vocabulary for all four harnesses
  (`bash read edit write grep glob ls`; extras `Skill`, `Agent`, `delete` render
  as generic cards). `canonicalTool` is therefore trim + lowercase
  passthrough, applied in `buildTimeline`; the synthetic `fileChange` /
  `compaction` check still uses the raw name. Nothing stored changes.
- **Codex's shell wrapper.** Codex records its command as
  `/bin/bash -lc "<cmd>"`. `unwrapShell` strips the wrapper for display only
  (group label, `BashTerminal` via `parseBash`).
- **Cancel.** `POST /api/x/harness-calls/<hc_…>/cancel` calls the existing
  `cancelRunTool`: 400 non-`hc_` id, 404 unknown, 409 not running, 200 ok. The
  call settles `cancelled` immediately (never wakes the chat) and the
  `harnessCall` workflow tears its bridge down at its next step boundary — we
  still never call `workflow.cancel()` on a harness run
  (see `lib/agent/tools/cancel-run.ts`). `CancelCallButton` (confirm → POST →
  "Stopping…") appears on the session header while a call runs (the per-call
  page's call, else the session's newest running call of that kind) and on the
  chat's `HarnessCard` for a live background call. `cancelled` renders neutral.

## Known limit

Cancel is cooperative: a single long semantic step finishes before the session
is torn down. A hard kill of the bridge process mid-step is a possible
follow-up if this bites.

## Checks

Timeline/parts mapping across harness-shaped events, group allow-list and
labels, session-log markup (pi, claude, codex-wrapped), cancel route status
codes, button markup and header tone. Gate: typecheck, lint, test.
