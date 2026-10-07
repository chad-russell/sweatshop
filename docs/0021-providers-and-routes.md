# 0021 — Providers and routes

Status: **implemented 2026-10-08** (Chad: "implement now" — approval;
one PR, sequenced commits). Roadmap item 1.2 (go-live floor). See
"Implementation notes" at the end for where the build differs from the
design above.

## Decisions (Chad, 2026-10-07)

0. **Generic, not workflow-shaped.** Sweatshop has no notion of "work" vs
   "personal", or of any particular employer. Everything here is a generic
   feature (providers, routes, per-project restrictions, settings) that a
   user configures to fit their own situation.
1. **Subscription harnesses are not provider-routed.** The claude and
   cursor harnesses exist to use a vendor subscription through that
   vendor's own tool, within its terms of service. They always run on the
   subscription credential (claude: `CLAUDE_CODE_OAUTH_TOKEN`; cursor:
   `CURSOR_API_KEY`), never repointed at another provider's endpoint, and
   any project may use them. **The model is still chosen per route**
   (e.g. claude opus vs sonnet, plus effort; cursor's model via its picker).
   **Everything else runs on pi** (harness work) or the in-process agent
   (chats, agent stages), and those are the only surfaces that take a
   provider.
2. Gloo and OpenRouter keys are copied from agenix into the service's
   `.env.local` for now (`GLOO_API_KEY`, `OPENROUTER_API_KEY`; done
   2026-10-07); the Secrets entity takes over later.
3. The default chat model stays `glm-5.3-flash`, and it is **a setting**,
   easy to swap (e.g. a cheap model while testing, a strong one for real
   use), not a constant.
4. **Projects can restrict their providers** (`projects.allowed_providers`,
   optional) and **their harnesses** (`projects.allowed_harnesses`,
   optional). Unset = everything available. A generic way to keep a
   project's code on the providers or subscriptions it is supposed to use,
   whatever the reason.

## Goal

Every place sweatshop runs a model (chats, agent stages, harness stages,
the chat's `pi` / `claude` tools, title generation) picks it the same way:
from one **route** that names the harness, the provider and the model.
Three providers at go-live: **GLM** (Z.AI coding plan, today's only
provider), **Gloo** (an OpenAI-compatible platform API), and
**OpenRouter**. Which provider a given project uses is configuration
(decision 4), not something sweatshop knows about. The route shape is what later carries fallbacks
(roadmap 2.1) and run overrides, so this doc fixes the shape and the
resolution order. It doesn't build fallbacks.

## Findings (verified 2026-10-07)

**Endpoints**, probed live with the household keys:

| Provider | OpenAI chat completions | Anthropic Messages | Tool calling | Model list API |
|---|---|---|---|---|
| GLM (Z.AI coding plan) | `api.z.ai/api/coding/paas/v4` (in use, `zhipu-ai-provider`) | `api.z.ai/api/anthropic` (in use by pi) | yes | no (static list in `lib/model.ts`) |
| Gloo | `platform.ai.gloo.com/ai/v2/chat/completions` → 200, streaming works | **none found** (`/messages` 404 on every path tried) | yes, **but every tool needs a `description`** (422 without) | **none** (`/models` 404); dsh/cn keep a static list of 23 `gloo-*` ids |
| OpenRouter | `openrouter.ai/api/v1` | `openrouter.ai/api/v1/messages` → 200 | yes (398 of 466 models advertise `tools`) | `GET /api/v1/models` (public) |

**Harness adapters**, read from the installed type declarations:

- **pi** (`@ai-sdk/harness-pi` → pi-coding-agent `ProviderConfig`) takes
  any number of providers, each with a `baseUrl`, `apiKey` and `api`.
  The `api` kinds include `openai-completions` and `anthropic-messages`.
  So pi can run on all three providers (Gloo via `openai-completions`).
- **claude** (`@ai-sdk/harness-claude-code`) is the Claude Agent SDK and
  speaks only Anthropic Messages. It *could* be repointed through `env:`
  (`ANTHROPIC_BASE_URL` at OpenRouter or GLM). Per decision 1 it never is:
  it runs only on its subscription token, exactly as today. (Gloo has no
  Anthropic surface anyway.) Claude *models* on any provider are reached
  through **pi**.
- **cursor** (`@ai-sdk/harness-cursor`, roadmap 3.2) runs the Cursor CLI over
  ACP. It authenticates only with a Cursor user API key (`CURSOR_API_KEY`);
  there is no interactive-login path in the adapter, so cursor stays
  blocked until such a key exists for the account. The model is passed as
  an ACP session config option (`modelMapping: session-config-option
  "model"`), so per-route model choice works.

**Current consumers** of a model choice, all hard-wired to Z.AI:
`lib/model.ts` (`zaiModel`, `CHAT_MODELS`, `resolveChatModel`),
`workflows/chat/model.ts` (`SerializableChatModel`, data
`{kind:"zai", modelId}`), `conversations.model_id` (76 rows null, 15
`glm-5.3-flash`), agent stages (`stage.model ?? input.model` through
`resolveChatModel`), harness stages (`buildHarnessAgent`: pi pinned to
`zai-glm/*`, `PI_MODEL` env; claude `model` passed through), the chat
`pi` / `claude` tools, and `lib/titles.ts` (GLM Flash). Live machines
set no per-stage models today.

**Package**: `@ai-sdk/openai-compatible@3.0.59` depends on exactly the
installed `@ai-sdk/provider@4.0.19` / `provider-utils@5.0.51`, so it adds
no duplicate copies. One package covers both Gloo and OpenRouter. The
OpenRouter-specific provider (`@openrouter/ai-sdk-provider`) isn't needed;
its extras (routing preferences, reasoning tokens) can wait for a real need.

## Design

### 1. Providers are code, keys are env

A small registry, `lib/providers/registry.ts`, holds one entry per
provider:

```ts
type ProviderId = "glm" | "gloo" | "openrouter";

interface ProviderDef {
  id: ProviderId;
  label: string;                 // "GLM (Z.AI)", "Gloo", "OpenRouter"
  keyEnv: string;                // ZAI_API_KEY | GLOO_API_KEY | OPENROUTER_API_KEY
  chat: (modelId: string) => LanguageModel;  // AI SDK model for chats/agent stages
  pi: PiProviderConfig;          // how pi reaches it (baseUrl + api kind)
  models: () => Promise<ModelInfo[]> | ModelInfo[];
}
```

- **GLM**: chat via the existing `zhipu-ai-provider`; pi via the Anthropic
  surface (today's wiring).
- **Gloo**: chat via `createOpenAICompatible`; pi via `openai-completions`.
  A request transform fills an empty tool `description` with the tool
  name, so the 422 never happens (the AI SDK omits the field when a tool
  has none). The same transform applies to pi's requests (a pi
  `onPayload`-style hook, or `streamSimple` wrapper if pi has no hook,
  checked in phase 3).
- **OpenRouter**: chat via `createOpenAICompatible`; pi via
  `openai-completions`.

The registry has no claude/cursor entries: those harnesses are not
provider-routed (decision 1).

Providers are fixed in code because each needs code (protocol quirks,
transforms). Adding one is a small PR, not a settings form. A provider
whose key env is unset is **unavailable**: hidden from pickers and
rejected at route validation with a clear message. Keys move to the
Secrets entity later (roadmap 2.2); the registry reads them through one
function, so that swap stays local.

### 2. Model catalogs

- **GLM**: the static list stays (no list API), moved into the registry.
- **Gloo**: a static list in code, seeded from the 23 ids cn already
  maintains for dsh (with context windows and vision flags from dsh's
  settings). Gloo has no list API, so updates are a PR.
- **OpenRouter**: fetched from `GET /api/v1/models`, cached in sqlite
  (`provider_models` table: provider, id, label, context window, tool
  support, fetched_at), refreshed at most daily. Pickers show only
  tool-capable models, because every sweatshop surface is agentic. A
  "Refresh models" action exists on the settings page.

A model id is always provider-local (`glm-5.3`, `gloo-openai-gpt-5.4`,
`anthropic/claude-sonnet-4.6`). Routes never encode the provider inside
the model string.

### 3. The route value

A route is a discriminated union. Provider-routed surfaces carry a
provider; subscription harnesses carry only what their subscription
offers:

```ts
type Route =
  | { harness?: undefined; provider: ProviderId; model: string }           // in-process agent: chats, agent stages
  | { harness: "pi"; provider: ProviderId; model: string; thinking?: Thinking }
  | { harness: "claude"; model?: string; effort?: "low" | "medium" | "high" | "xhigh" | "max" } // subscription only
  | { harness: "cursor"; model?: string };                                  // roadmap 3.2, subscription only
```

One zod schema (`lib/providers/route.ts`), `parseRoute`, and
`validateRoute(route, { project })`, which checks: provider available
(key present), model in the provider's catalog (OpenRouter: the cached
list), claude only when `CLAUDE_CODE_OAUTH_TOKEN` is set (cursor:
`CURSOR_API_KEY`), and the project's restrictions (decision 4; see §4). The schema has nowhere to
put a provider on claude/cursor, so the ToS rule holds by construction
rather than by validation. Errors are value-shaped
(`{ ok:false, issues:[…] }`) so agent tools can repair them, the same
convention as machine edits (0015).

### 4. Where routes live, and how they resolve

Layered, most specific wins:

1. **Run override**: `startRun({ route })` (whole run) or per stage. The
   API, `start_machine` tool and composer accept it. *Only the shape is
   built here; the UI for overrides lands with fallbacks (2.1).*
2. **Stage**: a machine stage's `route` (replaces today's `harness` +
   `model` + `thinking` fields on harness stages and `model` on agent
   stages).
3. **Conversation**: `conversations.route` (JSON), replacing `model_id`.
   It's set by the chat's model picker, and it's what the chat's own turns
   and its `pi` / `claude` tool calls inherit (with the tool's harness
   swapped in).
4. **Project default**: `projects.default_route`. This is how "open-bible
   uses Gloo" is said once.
5. **Global default**: the `settings` table (decision 3) holds one
   default per surface: **chat** (GLM `glm-5.3-flash`), **agent stage**
   (same), **pi** (GLM `glm-5.3-flash`, today's `PI_MODEL` default) and
   **claude** (model unset = the subscription's default). Swapping "the
   model we use" is changing one row on `/settings`, effective on the next
   turn.

Layers resolve per surface. A conversation or project route is a
chat/pi route (provider + model); a claude or cursor stage never inherits
it. It takes its own stage setting, else the global claude default. A
project default of Gloo therefore moves chats, agent stages and pi onto
Gloo, while claude keeps its own model setting.

**Project restrictions** (decision 4) apply after resolution, at every
layer: a resolved route whose provider is not in the project's
`allowed_providers`, or whose harness is not in `allowed_harnesses`, is
rejected with a value-shaped error naming the restriction (never silently
swapped for another route; fallbacks in 2.1 will respect the same lists).
Pickers inside a restricted project only offer allowed entries, and a
project's default route must itself be allowed. A project with neither
list set behaves exactly as unrestricted. The resolved route and **which layer
it came from** are recorded on every stage visit and chat turn
(`machine_stage_runs.route`, and a `route` on the turn's assistant message
metadata), so "what actually ran" is always answerable. Fallbacks (2.1)
extend exactly this record.

### 5. Making the route real at each consumer

- **Chats and agent stages**: `SerializableChatModel` data becomes
  `{ kind: "route", route }` (mock unchanged). Deserialization rebuilds the
  model through the registry. This keeps the workflow rule: the provider
  instance never crosses a step boundary, only its recipe.
- **pi**: `buildHarnessAgent` registers just the route's provider in
  `createPi({ providers })` and passes `model: "<provider>/<model>"`. The
  `PI_MODEL` env goes away (the global default replaces it).
- **claude**: unchanged auth (`CLAUDE_CODE_OAUTH_TOKEN`, `auth: "direct"`);
  the route only contributes `model` / `effort`.
- **Titles**: a `settings` entry of their own (default GLM `glm-5.3-flash`,
  cheap and fast), not per-conversation. Inside a restricted project the
  title call uses the project's default route instead if the titles
  default isn't allowed, so restrictions hold for every model call.

### 6. UI

- **Chat model picker** (existing `modelId` picker in `chat-session.tsx`):
  grouped by provider, unavailable providers hidden, OpenRouter searchable.
  The route shown in the header ("Gloo · gpt-5.4").
- **Project page**: "Models" section, with a default route plus optional
  allowed-providers and allowed-harnesses checklists (unset = all).
- **Machine editor**: the stage inspector's harness/model fields become
  one route picker. `edit.ts` gets a `setStageRoute` op (agent tools get
  it for free through `applyOps`).
- **`/settings`** (new, minimal, part of phase 2 so the default is
  swappable from the start): the per-surface defaults, provider
  availability (key present or not, never the value), "Refresh OpenRouter
  models". The chat picker shows which entry is the current default.

### 7. Migration

One drizzle migration:
- `conversations.route` (JSON, null), backfilled from `model_id`
  (`{provider:"glm", model}`); then **drop `model_id`** (no dual read, the
  0019 rule).
- `projects.default_route`, `projects.allowed_providers`,
  `projects.allowed_harnesses`, `machine_stage_runs.route`, `settings`,
  `provider_models`.
- Machine definitions: a data migration rewrites stored definitions.
  pi stages `{harness:"pi", model?, thinking?}` → `route: {harness:"pi",
  provider:"glm", model, thinking}`; claude stages → `route:
  {harness:"claude", model?}`; agent stages `model` → `route: {provider:
  "glm", model}`. The live rows set no models, so this is mostly
  structural. Seeds are updated to match; the `definition.ts` schema drops
  the old fields.
- Run snapshots (`machine_runs.definition`) are history. They're read
  through a tolerant mapper that understands the old shape for display only.
  No run is resumed across this migration (none are live).

## Phases

1. **Registry + route core**: `lib/providers/{registry,route,catalog}.ts`,
   `@ai-sdk/openai-compatible@3.0.59` (exact pin, with the provider pair),
   Gloo tool-description transform, store for `provider_models`/`settings`,
   unit tests (validation matrix, resolution layers, Gloo transform).
2. **Chats + settings**: `conversations.route` migration + backfill + drop
   `model_id`, `SerializableChatModel` on routes, the grouped picker, and
   `/settings` with the per-surface defaults. Live check: one chat turn per
   provider, including a tool call on Gloo, and a default swap on
   `/settings` taking effect on the next new chat.
3. **Harnesses**: pi on all three providers through the route (incl. the
   Gloo tool-description fix on pi's requests); claude keeps its
   subscription auth and takes model/effort from the route (opus vs
   sonnet selectable). The
   chat's `pi` tool inherits the conversation route. Live check: a pi turn
   on Gloo with a tool call, a pi turn on OpenRouter, a bounded claude turn
   (the existing opt-in spike) still green.
4. **Machines**: definition migration, stage `route`, resolution with the
   recorded layer, editor route picker, `setStageRoute` op, run-override
   shape on `startRun`.
5. **Project models**: default route, allowed providers/harnesses with
   enforcement at resolution (tests for each layer and for the title
   call), project page section; OpenRouter refresh.

Each phase is its own PR with the gate green.

## Out of scope

- Fallback chains and the "retry this stage with…" UI (roadmap 2.1; the
  route record here is their foundation).
- Usage/cost tracking per route (open question in the roadmap).
- Cursor (3.2), Secrets-backed keys (2.2).
- Per-route prompt caching or provider-specific tuning.

## Questions for Chad

None outstanding. The three from the first draft are answered in
"Decisions".

## Implementation notes (2026-10-08)

Verified live on a copy of the production DB (isolated server, port
3390): a chat turn on each provider (GLM via the global default; Gloo
and OpenRouter with a real tool round-trip), a `/settings` swap taking
effect on the next new chat, a project default + restriction (a
forbidden route rejected with the reason; narrowing providers so the
default would be forbidden refused), a machine run with a per-stage
override (`layer: "run-stage"` recorded), pi on all three providers
through the real `buildHarnessAgent`, and a bounded claude turn on a
route (model + effort).

Differences from the design:

- **No pi-side Gloo transform.** A negative control (pi on Gloo with an
  undescribed host tool, fix disabled) passed: harness-pi already gives
  every host tool a description. The chat-side transform is required —
  the same control on the chat path returns 422 without it.
- **pi providers are namespaced** (`ss-glm`, `ss-gloo`, `ss-openrouter`)
  and register the route's model explicitly (`models: [...]` with
  catalog sizing), so pi never consults its built-in catalog.
  `PI_MODEL` and the old `zai-glm` provider are gone.
- **Restriction enforcement also happens at write time**: the chat
  route rejects a picked route the project forbids before anything is
  created; `startRun` rejects overrides that cannot run (missing key,
  forbidden, wrong shape for the stage kind) with a value-shaped error.
- **Route failures are fatal, not retried**: a missing key or a
  restriction fails the chat turn (FatalError) or parks the run at that
  visit with the reason, instead of retrying a deterministic failure.
- **Stage routes**: a harness stage keeps its `harness` field, and its
  optional `route` must match it (schema check; switching harness drops
  a mismatched route). The machine editor is read-only since 0031, so
  the "route picker in the editor" became the `set_route` edit op (the
  agent surface) plus the JSON tab; the run view shows each visit's
  route with its layer on hover.
- **Model picker is per conversation, not sticky**: the old
  localStorage "last model" is gone — a fresh chat starts on the
  default (that is what makes a `/settings` swap meaningful), and the
  route is sent only when Chad picks.
- **Migration**: `0036` (tables/columns + stripping the old stage
  `model`/`thinking` fields — none were set in live data), `0037`
  (`conversations.route` + backfill from `model_id`), `0038` (drop
  `model_id`). Checked against a copy of the live DB: 15 routes
  backfilled, 76 null.
