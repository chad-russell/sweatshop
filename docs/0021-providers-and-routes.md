# 0021 — Providers and routes

Status: **draft — awaiting Chad's approval.** Roadmap item 1.2 (go-live
floor).

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
- **claude** (`@ai-sdk/harness-claude-code`) is the Claude Agent SDK. It
  speaks only the Anthropic Messages protocol. Endpoint and credentials come
  from env passed through `env:` (`ANTHROPIC_BASE_URL`, plus
  `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`; today
  `CLAUDE_CODE_OAUTH_TOKEN`). So claude can run on its **own subscription**
  (today), **OpenRouter** (Anthropic surface verified), or **GLM's**
  Anthropic surface. It can't run on **Gloo** because Gloo has no Anthropic
  surface. Employer claude work therefore means claude on OpenRouter or the
  subscription, or Gloo's Anthropic models through **pi** instead.
- **cursor** (roadmap 3.2) brings its own account; not a provider route.

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
  pi?: PiProviderConfig;         // how pi reaches it (baseUrl + api kind)
  claude?: { baseUrl?: string; authEnv: "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN" };
  models: () => Promise<ModelInfo[]> | ModelInfo[];
}
```

- **GLM**: chat via the existing `zhipu-ai-provider`; pi via the Anthropic
  surface (today's wiring); claude via `api.z.ai/api/anthropic`.
- **Gloo**: chat via `createOpenAICompatible`; pi via `openai-completions`;
  **no claude entry**. A request transform fills an empty tool
  `description` with the tool name, so the 422 never happens (the AI SDK
  omits the field when a tool has none).
- **OpenRouter**: chat via `createOpenAICompatible`; pi via
  `openai-completions`; claude via `openrouter.ai/api` + `ANTHROPIC_AUTH_TOKEN`.
- **claude's own subscription** stays as a fourth claude-only credential
  (`CLAUDE_CODE_OAUTH_TOKEN`, today's path), represented as the
  pseudo-provider `anthropic-sub`, valid only with `harness: "claude"`.

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

```ts
type Route = {
  harness?: "pi" | "claude";   // absent = in-process AI SDK agent (chats, agent stages)
  provider: ProviderId | "anthropic-sub";
  model: string;
  thinking?: "off" | "low" | "medium" | "high";  // harness-specific mapping
};
```

One zod schema (`lib/providers/route.ts`), `parseRoute`, and
`validateRoute(route, { surface })`, which checks the combination:
provider available, `claude` only with an Anthropic-capable provider,
`anthropic-sub` only with `claude`, model in the provider's catalog
(OpenRouter: in the cached list). Errors are value-shaped
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
5. **Global default**: `settings.default_route` (a one-row `settings`
   table): GLM `glm-5.3-flash` for chat, pi on GLM for harness calls,
   claude on `anthropic-sub` for claude calls.

Harness surfaces resolve per harness. A stage of `harness: "claude"` takes
the first layer that has a **claude-valid** route. If a project's
default is Gloo (no claude), a claude stage falls through to the global
claude default rather than failing. The resolved route and **which layer
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
- **claude**: `env` carries `ANTHROPIC_BASE_URL` + the route's auth var, or
  `CLAUDE_CODE_OAUTH_TOKEN` for `anthropic-sub`; `model` passes through.
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
- **`/settings`** (new, minimal): global defaults, provider availability
  (key present or not, never the value), "Refresh OpenRouter models".

### 7. Migration

One drizzle migration:
- `conversations.route` (JSON, null), backfilled from `model_id`
  (`{provider:"glm", model}`); then **drop `model_id`** (no dual read, the
  0019 rule).
- `projects.default_route`, `machine_stage_runs.route`, `settings`,
  `provider_models`.
- Machine definitions: a data migration rewrites stored definitions,
  harness stages `{harness, model?, thinking?}` → `route: {harness,
  provider:"glm"|"anthropic-sub", model, thinking}`, agent stages
  `model` → `route`. The live rows set no models, so this is mostly
  structural. Seeds updated to match. The `definition.ts` schema drops the
  old fields.
- Run snapshots (`machine_runs.definition`) are history. They're read
  through a tolerant mapper that understands the old shape for display only.
  No run is resumed across this migration (none are live).

## Phases

1. **Registry + route core**: `lib/providers/{registry,route,catalog}.ts`,
   `@ai-sdk/openai-compatible@3.0.59` (exact pin, with the provider pair),
   Gloo tool-description transform, store for `provider_models`/`settings`,
   unit tests (validation matrix, resolution layers, Gloo transform).
2. **Chats**: `conversations.route` migration + backfill + drop `model_id`,
   `SerializableChatModel` on routes, the picker. Live check: one chat turn
   per provider, including a tool call on Gloo.
3. **Harnesses**: pi on all three providers and claude on `anthropic-sub` /
   OpenRouter through the route. The chat's `pi`/`claude` tools inherit the
   conversation route. Live check: a pi turn on Gloo, a claude turn on
   OpenRouter (bounded, opt-in like the existing claude spike).
4. **Machines**: definition migration, stage `route`, resolution with the
   recorded layer, editor route picker, `setStageRoute` op, run-override
   shape on `startRun`.
5. **Project default + `/settings`**: project page field, settings page,
   OpenRouter refresh.

Each phase is its own PR with the gate green.

## Out of scope

- Fallback chains and the "retry this stage with…" UI (roadmap 2.1; the
  route record here is their foundation).
- Usage/cost tracking per route (open question in the roadmap).
- Cursor (3.2), Secrets-backed keys (2.2).
- Per-route prompt caching or provider-specific tuning.

## Questions for Chad

1. **claude for employer work**: Gloo has no Anthropic surface, so claude
   can't run on Gloo. For employer projects, is claude on your personal
   subscription (today) or OpenRouter acceptable, or should employer
   projects use **pi on Gloo's Claude models** instead of the claude
   harness?
2. **Gloo key**: OK to add `GLOO_API_KEY` and `OPENROUTER_API_KEY` to the
   sweatshop service's `.env.local`, copied from the existing agenix
   secrets (`gloo-api-key`, `openrouter-api-key`)? (Secrets entity later.)
3. **Global default chat model**: stay on GLM `glm-5.3-flash`, or
   `glm-5.3`?
