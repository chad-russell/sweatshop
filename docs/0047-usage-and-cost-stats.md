# 0047 — Usage & cost stats: metering what a ticket costs

Status: **draft — decisions locked with Chad in chat (2026-10-17); awaiting
approval before implementation.** New subsystem (capture + pricing + read +
UI), so it gets this numbered doc per AGENTS.md.

## The problem

Sweatshop knows what ran (routes on message rows, `harness_calls` rows,
`pending_inputs` timing) but not what it *cost*. No token counts are captured
anywhere: the chat turn loop discards the AI SDK usage objects, and the
harness event sink drops the usage-bearing chunks. The goal is per-ticket
accountability — "what did this thread, and every child it spawned, cost the
company?" — with Gloo costs accurate to the cent, plus the time and touch
metrics already half-present in the schema.

Decisions from the working session (Chad, 2026-10-17):

- **Rollup scope**: the conversation tree (root + `start_thread` descendants,
  0046 locked groups) + their `harness_calls`. Historical machine-run
  conversations are out of scope.
- **Gloo is the accuracy target**: the company pays per token; costs must be
  computed exactly, not estimated.
- **Titles are excluded** from cost (small, invisible, deliberately
  unmetered).
- **Subscriptions (GLM coding plan, claude, cursor)**: tokens/steps/time are
  counted; **no dollar figure is invented**. Amendment 0062: a harness that
  reports its own cost has it recorded — Claude Code's cumulative
  `total_cost_usd` (`harnessMetadata['claude-code'].costUsd` on the finish
  part) lands in `cost_usd` with `cost_basis = 'reported'` (latest report
  wins within a call; never summed) and counts in totals, the donut and
  the lists, tagged "reported". Cursor/Codex report nothing and stay in
  the "No cost reported" section. Caveat: the adapter says the figure
  carries forward across resumed sessions, so a call that resumes an
  earlier Claude session may over-report by that session's prior cost.
- **Forward-only**: metering starts at deploy; nothing is backfilled from
  provider dashboards.
- **Surface**: a stats drawer in the chat header (not a page), opened when
  needed.
- **Implementation harness: Cursor** (once this doc is approved).

## Gloo pricing — solved from the public API

`GET https://platform.ai.gloo.com/platform/v2/models` — **public, no auth** —
returns exact per-1M-token rates for every model in sweatshop's Gloo catalog:

- `pricing.input` / `pricing.output` — per-1M rates (`rate_per_1m_tokens`,
  plus an exact `rate_per_1k_tokens_exact`).
- `pricing.cache_read` — the discounted rate for cached input tokens.
- `pricing.cache_write` — tiered `{ "5m": …, "1h": … }` on Anthropic-family
  models, `{ default: … }` flat on others (Gemini/Qwen/etc.), absent where
  there is no write fee (OpenAI family).
- `pricing.long_context` — an array of tiers, each with a
  `min_prompt_tokens` threshold and separate input/output/cache_read (and
  tiered cache_write) rates. Long threads DO cross these thresholds (Claude
  Haiku 5.5 at 100k, GPT-5.4/5.5/5.6 at 272k, Claude Sonnet 4.5/4.6 at 200k),
  so the cost function takes the input token count and picks the matching
  tier, else the base rates.
- `is_deprecated` / `replacement_model` — Gloo silently reroutes deprecated
  ids to a replacement; sweatshop's static catalog has deprecated ids (e.g.
  `gloo-anthropic-claude-sonnet-4.5` → `gloo-anthropic-claude-sonnet-5`). The
  price lookup follows `replacement_model` when the fetched entry is
  deprecated, and the fetcher maps pricing onto the catalog ids sweatshop
  actually calls.

Verified live 2026-10-17 (the payload above is real, not docs-quoted). One
calibration unknown remains: those are **list** prices. Guarded endpoints add
a 6.5% platform fee; direct endpoints bill at list. Sweatshop calls the bare
`/ai/v2/chat/completions` — an alias predating the guarded/direct split in
the docs, and which surface it maps to is not documented. **Calibration
plan**: `model_prices.platform_fee` multiplier (default 1.0); one live test
request at implementation time, checked against Gloo Studio's Usage dashboard
("Monitor API requests, tokens, and costs"), sets it to 1.0 or 1.065 once.
That dashboard is also the reconciliation source for any future audit.

## Cost model

Cost is computed **at capture time** with the then-current price row, and
stored on the event — price changes never rewrite history. All units
per-1M-token USD:

```
input billed  = fresh_input × input_rate            (input = total_input − cached)
             + cached_input × cache_read_rate
output billed = output × output_rate
cost          = (input billed + output billed) × platform_fee   [gloo only]
```

- `cached` comes from the provider usage when reported (`cachedInputTokens`
  on the AI SDK's usage object; `prompt_tokens_details.cached_tokens` on the
  wire). If the provider doesn't report it, cached = 0 and cache stats show
  "unknown" rather than guessing.
- Reasoning tokens: counted as output (they are billed as output); recorded
  separately on the event for display.
- Long-context tiers: pick the highest tier whose `min_prompt_tokens` ≤
  input tokens, use its rates.
- No price row (GLM plan, claude, cursor, unknown OpenRouter id) →
  `cost_usd` is null. Tokens still counted. The UI shows a "plan" chip
  instead of dollars.
- OpenRouter rows are auto-populated from the existing catalog refresh
  (its `/api/v1/models` payload carries `pricing` per token kind — extend
  `parseOpenRouterModels`, currently discarding it).
- Every price row keeps `source` (`gloo-v2-models` | `openrouter-catalog` |
  `manual`) and `fetched_at`; the catalog sweep refreshes Gloo daily like
  OpenRouter's (no key needed).

## Capture

Two producers, one table:

1. **Chat turns** (`workflows/chat/turn.ts`): the slice loop already receives
   per-slice results from `agent.stream` — sum the usage objects across
   slices into a turn total, and record one `usage_events` row per turn,
   written by the final `persistTurn` step (the row's `turn_key` = the
   message-id `skip` key already used for deterministic row ids). Steps =
   slices run; tool calls counted from tool-call parts in the turn's
   messages; span = turn start → final persist.
2. **Harness calls** (`harness-call.ts` settle path): pi/claude/cursor
   events flow through `harnessEventSink` — usage-bearing chunks
   (`finish-step`/`message-metadata`) are currently DROPPED by
   `uiChunkToModelPart`. Capture instead: accumulate usage in the sink (a new
   `onUsage` hook, mirroring `onToolStart`), accumulate into the call's
   state, settle into the `harness_calls` row (new nullable columns) and one
   `usage_events` row per call. **Spike first** (see Open questions): the
   exact chunk shape and whether claude/cursor expose usage at all is
   verified in a live session before the capture code is final.
3. **Titles** (`lib/titles.ts`): excluded by decision — no capture.

Every event also records the resolved route (provider/model/harness), the
conversation, and `source` (`chat` | `harness`), so route breakdowns and
per-child attribution come straight off the rows.

## Storage

Migration `0054_usage_stats.sql`:

```sql
-- One row per metered unit: a chat turn or a harness call.
CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,              -- u_<conv>_<skip> chat | u_hc_<callId> harness
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source TEXT NOT NULL,             -- 'chat' | 'harness'
  harness_call_id TEXT,             -- the hc_ id when source='harness'
  route TEXT NOT NULL,              -- JSON: what ran (provider+model, or harness+model)
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER,         -- display-only slice of output
  steps INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,                    -- NULL = no price row (plan/subscription)
  started_at INTEGER NOT NULL,      -- Unix ms
  ended_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX usage_events_conversation_idx ON usage_events(conversation_id);

-- Per-model price rows, refreshed by the catalog sweep.
CREATE TABLE model_prices (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_per_m REAL NOT NULL,
  output_per_m REAL NOT NULL,
  cache_read_per_m REAL,            -- NULL = no separate cache pricing
  cache_write_per_m REAL,           -- NULL = no write fee
  long_context TEXT,                -- JSON array of {minPromptTokens, ...rates}
  platform_fee REAL NOT NULL DEFAULT 1.0,
  source TEXT NOT NULL,             -- 'gloo-v2-models' | 'openrouter-catalog' | 'manual'
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model)
);
```

No new columns on `harness_calls` — usage lands in `usage_events` (one row
per call, `harness_call_id` FK-free reference; purge follows the existing
conversation cascade).

## Read & UI — the stats drawer

**Read**: `GET /api/x/stats/<conversationId>` — resolves the group root
(`rootConversationId` — exported from `db/organize.ts` for this), collects
`conversationGroupIds`, aggregates `usage_events` + `harness_calls` +
`pending_inputs` timing across the group. Live conversations are computed on
request (no pre-aggregation table; groups are small and the query is
index-scoped by conversation).

**UI**: a `stats` button in the chat header (`components/chat.tsx`) opens an
overlay drawer — the house pattern from `components/agent-panel.tsx`: fixed
right, `border-l bg-background`, full-width below `md`, no new dependency
(no Sheet primitive exists; this repo builds panels this way). Closes on
Escape / backdrop click. Tasteful per DESIGN.md: semantic tokens only, mono
for numbers, `chart-1..5` for the donut arcs, proportional bars for shares.

Layout, top to bottom:

1. **Two hero figures** side by side — `Total $X.XX` (metered only; metered
   total, with "N unmetered" line when plan sources exist) and wall time
   (`created_at` → last activity). Beneath the heroes: the work/wait split —
   "agents worked Xm · waiting on you Ym".
2. **Cost by model — donut**: hand-rolled SVG (two-circle mask or arc
   strokes; no charting dependency — build over buy). Arcs = metered cost
   share by (provider, model), colors `chart-1..5`, center label = total $.
   Legend rows: model label, $, %, tokens, cache-hit %.
   Unmetered sources are NOT arcs — they sit under the donut as "plan" rows.
3. **Plan rows** (subscriptions): GLM / Claude / Cursor with tokens, steps,
   tool calls, and a `plan` badge — no dollars.
4. **Time strip**: single stacked horizontal bar — work · waiting-on-you ·
   idle — computed from turn/harness spans (work) minus overlapping
   `pending_inputs` spans (wait). Beside it: touches (real user messages,
   wake-chip rows excluded) and avg response latency (median of
   `resolved_at − created_at` on answered pending inputs).
5. **Per-model table**: proportional token-share bar, tokens in/out/cached,
   cost right-aligned mono. Expandable per-child rows beneath: each child
   conversation / harness call with its own $, tokens, time, and link
   (`/c/<id>` or `/h/<kind>/<conv>/<callId>`).
6. **Cache hit rate**: one number (cached/input across metered input) in the
   donut legend + per-model rows, plus the total estimated savings vs
   all-fresh pricing — the cost function already prices cache segments
   correctly, so this is display-only.

## What each number means

- **Wall time**: root `created_at` → group's max(`updated_at`). Includes
  waiting.
- **Agent work time**: Σ per-event `ended_at − started_at` (turns + harness
  calls). Tool execution counts as work (the sandbox is busy). Parallel
  children sum, not critical-path.
- **Waiting on you**: Σ overlapping (`resolved_at − created_at`) on answered
  `pending_inputs` in the group, clipped to the group's turn spans.
- **Touches**: real user rows (role=user, no `runEvent` metadata) in the
  group.
- **Idle**: wall − work − wait, floored at 0. Display-only.

## Cache enablement (optional amendment, recommended)

**Implemented by 0055 (2026-10-20):** five-minute Anthropic opt-in,
read/write normalization and metering, and the documented guarded fee.
The following is the original proposal; 0055 owns the current contract.

Sweatshop never sends `X-Cache-TTL` (Anthropic-via-Gloo) or
`prompt_cache_key` (OpenAI-via-Gloo), and the chat path resends the entire
growing history every slice — a 50-step thread pays quadratic full-price
input. The provider transforms (`transformRequestBody`) are the natural
place: add the header / body field when the route's provider is gloo and the
model family matches. This doc's cost model already prices cache segments,
so the stats drawer will SHOW the win. Estimated input-cost cut on long
threads: 5–10×. Scoped small; can ship separately from the metering work.

## Testing

- Pure cost function: table-driven tests over rates / cache splits / long
  context tiers / missing price rows (null cost) / platform fee multiplier.
- Gloo payload parser: fixture from the live response (2026-10-17) — rates
  extraction, cache_write tiers (5m/1h vs default), long_context tiers,
  deprecated → replacement mapping.
- Capture: mock model already emits `finish` parts with `usage` (extend the
  script to vary counts); assert the `usage_events` row per turn; harness
  mock emits a usage chunk once the spike fixes its shape.
- Read: store tests with a fabricated group tree — rollup sums, wait
  clipping, touches count, plan-row separation (null cost rows never add to
  dollars).
- UI: happy-path render test of the drawer with a fixture payload.

## Open questions (to resolve in the implementation spike)

1. Exact usage shape on `WorkflowAgent`'s stream result (per-slice `usage`
   field) — read from the installed `@ai-sdk/workflow` types; the mock model
   will pin it in tests.
2. Harness sink usage chunk shape (`finish-step` metadata?) for pi/claude/
   cursor — one live session each; claude's `costUSD` if exposed by
   `@ai-sdk/harness-claude-code`.
3. Does Gloo's OpenAI-compatible surface report `prompt_tokens_details.
   cached_tokens`? If not: cached = 0, "cache unknown" in UI (never guess).
4. The bare `/ai/v2/chat/completions` platform-fee calibration (1.0 vs
   1.065) against the Gloo Usage dashboard.
