# 0021 — Providers and routes

Status: **draft, revised 2026-10-07 after Chad's answers — awaiting
approval.** Roadmap item 1.2 (go-live floor).

## Decisions (Chad, 2026-10-07)

1. **claude and cursor exist only to use Chad's own subscriptions in a way
   that meets each vendor's terms of service.** They always run on their
   subscription (claude: `CLAUDE_CODE_OAUTH_TOKEN`; cursor: its own login),
   never repointed at another provider's endpoint. **Everything else runs on
   pi** (harness work) or the in-process agent (chats, agent stages), and
   those are the only surfaces that take a provider.
2. Gloo and OpenRouter keys are copied from agenix into the service's
   `.env.local` for now (`GLOO_API_KEY`, `OPENROUTER_API_KEY`; done
   2026-10-07); the Secrets entity takes over later.
3. The default chat model stays `glm-5.3-flash`, and it is **a setting**,
   easy to swap (e.g. a cheap model while testing, a strong one for real
   work), not a constant.

## Goal

Every place sweatshop runs a model (chats, agent stages, harness stages,
the chat's `pi` / `claude` tools, title generation) picks it the same way:
from one **route** that names the harness, the provider and the model.
Three providers at go-live: **GLM** (Z.AI coding plan, today's only
provider), **Gloo** (employer-paid; most of Chad's work), and
**OpenRouter**. No work/personal distinction beyond which route is chosen
(interview decision). The route shape is what later carries fallbacks
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
  it runs only on Chad's subscription token, exactly as today. (Gloo has no
  Anthropic surface anyway.) Claude *models* on any provider are reached
  through **pi**.
- **cursor** (roadmap 3.2) likewise runs only on its own login.

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
`validateRoute(route)`, which checks: provider available (key present),
model in the provider's catalog (OpenRouter: the cached list), claude
only when `CLAUDE_CODE_OAUTH_TOKEN` is set. The schema has nowhere to
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
project saying "use Gloo" therefore moves chats, agent stages and pi onto
Gloo, while claude stays on the subscription. The resolved route and **which layer
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
- **Titles**: stay on GLM Flash (cheap, personal subscription). No route.

### 6. UI

- **Chat model picker** (existing `modelId` picker in `chat-session.tsx`):
  grouped by provider, unavailable providers hidden, OpenRouter searchable.
  The route shown in the header ("Gloo · gpt-5.4").
- **Project page**: a "Default model" field (route picker, plus separate
  pi/claude defaults if wanted).
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
- `projects.default_route`, `machine_stage_runs.route`, `settings`,
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
   subscription auth and takes only model/effort from the route. The
   chat's `pi` tool inherits the conversation route. Live check: a pi turn
   on Gloo with a tool call, a pi turn on OpenRouter, a bounded claude turn
   (the existing opt-in spike) still green.
4. **Machines**: definition migration, stage `route`, resolution with the
   recorded layer, editor route picker, `setStageRoute` op, run-override
   shape on `startRun`.
5. **Project default**: project page field; OpenRouter refresh.

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
