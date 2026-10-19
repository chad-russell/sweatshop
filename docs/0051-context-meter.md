# 0051 — Context-window meter per chat

Status: approved (plan v1, chat 2026-10-19). ROADMAP item 7.

## Problem

A chat's context fills as a thread grows, and nothing shows it. Chad's
use case is the simple one: "oops, context is at 80% — I should wrap
this up." Long turns burn real money (0047) and, once input approaches
the model's window, quality and correctness degrade silently. Other
harnesses show a context meter; sweatshop should too.

0047 laid most of the groundwork: one `usage_events` row per chat turn
(`u_<conv>_<skip>`) with summed tokens, the route, and cost, written at
turn end. What it does not keep is per-slice usage, so it cannot answer
"how full is the context *now*" — a turn's summed input across slices
over-counts (each slice re-sends the whole conversation).

## Semantics

**Context usage after a turn = the LAST slice's `inputTokens +
outputTokens` (+ `reasoningTokens` when reported).** The last slice's
input re-sent the entire conversation, so it IS the conversation's size
in tokens; its output is about to join it. Cached tokens count once
(input already includes them — the same model as `computeCost`'s
`fresh = input − cached`).

Scope: **per chat, not per thread-group.** Each conversation feeds its
own model with its own history; children and harness calls never enter
a parent's context. Group totals stay in the stats drawer (0047).

Near-limit behavior: **warn only** (roadmap's open question, answered
for v1). Warning tone at ≥ 85%, danger at ≥ 95%. No compaction, no
fresh-thread affordances — the number tells Chad it's time to wrap up.

Forward-only metering, per 0047: rows before this change have no
last-slice columns (NULL) and the meter stays hidden until a chat has
metered turns.

## Storage

`usage_events` gains four nullable columns (migration 0056, hand-written
— the drizzle snapshot gap is ROADMAP item 8, unchanged):

- `last_input_tokens`, `last_cached_tokens`, `last_output_tokens`,
  `last_reasoning_tokens` — the turn's final slice's `UsageCounts`.

Written by the same `recordUsageStep` write at turn end: `turn.ts`
already reads each slice's usage (`readSliceUsage`); it now also keeps
the last one and passes it through. The write stays insert-only and
idempotent (`onConflictDoNothing`).

## Read path

- `db/usage.ts` — `readContextUsage(db, conversationId)`: the
  conversation's latest `source = 'chat'` row (by `ended_at`, tie-break
  `created_at`/id) → last-slice counts + route JSON.
- `lib/usage/stats.ts` — `readConversationStats` gains
  `context: { usedTokens, windowTokens, pct } | null`. Window resolves
  through the provider catalog (`lib/providers/catalog.ts` static,
  `db/providers.ts` cached OpenRouter rows) for the row's route; unknown
  model or unmetered chat → null (UI hidden).
- The stats API route is unchanged — the drawer payload grows the block.

## UI

The **percentage leads** (Chad's call, plan v1): a slim chip in the chat
header beside the stats drawer — `62%` mono numerals with a thin
fraction bar, neutral tone below 85%, warning 85–94%, danger ≥ 95%,
tooltip with exact `used / window` tokens. A fuller readout
(used / window / bar) sits in the stats drawer beside the token totals.

Refresh: the chip re-fetches the stats endpoint when a turn settles
(the stream finish), not on a timer. Mid-turn growth within the running
turn is out of scope — the reading updates when the turn ends.

## Testing

- `usage-store.test.ts`: last-slice columns persist;
  `readContextUsage` picks the latest chat row, ignores harness rows.
- `usage-turn.test.ts`: `lastSliceUsage` flows to the row; a
  multi-slice turn records the LAST slice.
- `usage-api.test.ts`: context block present / absent (no metered rows)
  / null window (unknown model).
- Visual: preview + agent-browser BEFORE/AFTER with a seeded metered
  conversation.
