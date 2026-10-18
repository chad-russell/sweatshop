/**
 * 0021: static model catalogs for the providers that have no list API
 * (GLM, Gloo). OpenRouter's catalog is fetched and cached in sqlite
 * (db/providers.ts). Pure data — imported by the registry, the route
 * validator, and the client pickers.
 *
 * contextWindow is advisory sizing (pi's model registration needs it);
 * never set it above the endpoint's real limit.
 */

export type ProviderId = "glm" | "gloo" | "openrouter";
export const PROVIDER_IDS = ["glm", "gloo", "openrouter"] as const satisfies readonly ProviderId[];

/**
 * How a model exposes reasoning control (0021 amendment). Absent/none =
 * no knob — a thinking level on such a model is rejected at validation,
 * never silently sent (effort params hard-400 on non-reasoning models).
 * "switch" = on/off only (GLM 4.5/5.0-line); "effort" = leveled
 * (GLM 5.2+ reasoningEffort; OpenAI-style reasoning_effort).
 */
export type ReasoningKind = "switch" | "effort";

export interface ModelInfo {
  /** Provider-local model id (never prefixed with the provider). */
  id: string;
  label: string;
  contextWindow: number;
  maxTokens: number;
  vision?: boolean;
  /** The model's reasoning control; absent = none. */
  reasoning?: ReasoningKind;
}

/**
 * GLM coding plan. Verified against the live endpoint (2026-10-07):
 * glm-5.3 and glm-5.3-flash answer 200; the `[1m]` suffix is
 * Anthropic-surface only; glm-5.3-flashx is not on the plan. Older ids
 * are server-side aliases, so they are not offered. 5.x models carry
 * the provider's reasoning-effort setting ("GLM-5.2+", per
 * zhipu-ai-provider) on top of the thinking switch.
 */
export const GLM_MODELS: readonly ModelInfo[] = [
  { id: "glm-5.3-flash", label: "GLM 5.3 Flash", contextWindow: 128_000, maxTokens: 32_000, reasoning: "effort" },
  { id: "glm-5.3", label: "GLM 5.3", contextWindow: 128_000, maxTokens: 32_000, reasoning: "effort" },
];

/**
 * Gloo platform — no list API (/models 404), so the ids are the set cn
 * maintains for dsh (modules/dsh.nix `glooModels`, verified live
 * 2026-10-01). Updates are a PR. reasoning marks the models whose
 * OpenAI-normalized surface takes `reasoning_effort` — the clearly
 * reasoning-first families. Live-checked (THINKING_SPIKE, 2026-10-08):
 * gpt-6-sol accepts it and reasons; claude models accept-but-ignore a
 * stray effort param (safe, inert — so they stay unmarked).
 */
export const GLOO_MODELS: readonly ModelInfo[] = [
  { id: "gloo-anthropic-claude-opus-5.5", label: "Claude Opus 5.5", contextWindow: 1_000_000, maxTokens: 128_000, vision: true },
  { id: "gloo-anthropic-claude-sonnet-5.5", label: "Claude Sonnet 5.5", contextWindow: 1_000_000, maxTokens: 128_000, vision: true },
  { id: "gloo-anthropic-claude-haiku-4.5", label: "Claude Haiku 4.5", contextWindow: 200_000, maxTokens: 64_000, vision: true },
  { id: "gloo-openai-gpt-6-astra", label: "GPT-6 Astra", contextWindow: 1_050_000, maxTokens: 128_000, vision: true, reasoning: "effort" },
  { id: "gloo-openai-gpt-6-luna", label: "GPT-6 Luna", contextWindow: 1_050_000, maxTokens: 128_000, vision: true, reasoning: "effort" },
  { id: "gloo-openai-gpt-6-sol", label: "GPT-6 Sol", contextWindow: 1_050_000, maxTokens: 128_000, vision: true, reasoning: "effort" },
  { id: "gloo-google-gemini-3.5-flash", label: "Gemini 3.5 Flash", contextWindow: 1_048_576, maxTokens: 65_536, vision: true },
  { id: "gloo-google-gemini-3.1-pro", label: "Gemini 3.1 Pro", contextWindow: 1_048_576, maxTokens: 65_536, vision: true },
  { id: "gloo-google-gemini-2.5-pro", label: "Gemini 2.5 Pro", contextWindow: 1_048_576, maxTokens: 65_536, vision: true },
  { id: "gloo-deepseek-v4-pro", label: "DeepSeek V4 Pro", contextWindow: 1_048_576, maxTokens: 384_000, reasoning: "effort" },
  { id: "gloo-deepseek-v4-flash", label: "DeepSeek V4 Flash", contextWindow: 1_048_575, maxTokens: 4_096, reasoning: "effort" },
  { id: "gloo-xai-grok-4.5", label: "Grok 4.5", contextWindow: 500_000, maxTokens: 4_096, vision: true },
  { id: "gloo-qwen-3.8-max", label: "Qwen 3.8 Max", contextWindow: 1_000_000, maxTokens: 65_536, vision: true },
  { id: "gloo-qwen-3.8-flash", label: "Qwen 3.8 Flash", contextWindow: 262_144, maxTokens: 64_000 },
  { id: "gloo-kimi-k3", label: "Kimi K3", contextWindow: 1_048_576, maxTokens: 131_072, vision: true },
  { id: "gloo-z-ai-glm-5.2", label: "GLM 5.2", contextWindow: 1_048_576, maxTokens: 131_072, reasoning: "effort" },
  { id: "gloo-minimax-m3", label: "MiniMax M3", contextWindow: 524_288, maxTokens: 512_000, vision: true },
  { id: "gloo-mistral-large-3", label: "Mistral Large 3", contextWindow: 262_144, maxTokens: 4_096, vision: true },
];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  glm: "GLM (Z.AI)",
  gloo: "Gloo",
  openrouter: "OpenRouter",
};

/** Env var each provider's key is read from (0021 decision 2). */
export const PROVIDER_KEY_ENV: Record<ProviderId, string> = {
  glm: "ZAI_API_KEY",
  gloo: "GLOO_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/** Static catalog for a provider; null = dynamic (OpenRouter). */
export function staticModels(provider: ProviderId): readonly ModelInfo[] | null {
  if (provider === "glm") return GLM_MODELS;
  if (provider === "gloo") return GLOO_MODELS;
  return null;
}

/**
 * 0038: model ids offered for the Cursor harness, in ACP's vocabulary —
 * the adapter hands the route's model straight to ACP's `model` session
 * option, and ACP rejects anything it does not list ("Invalid params",
 * mid-turn). That is NOT the vocabulary of `agent --list-models`
 * ("gpt-5.6-sol-high", "auto"): ACP has base ids with effort, context
 * and speed as separate options. Unset = Cursor's own default
 * ("auto-smart"). `tests/fixtures/cursor-acp-models.ts` is the full
 * accepted set; a test pins this list to it.
 */
export const CURSOR_MODELS: readonly { id: string; label: string }[] = [
  { id: "auto-smart", label: "Auto" },
  { id: "composer-2.5", label: "Composer 2.5" },
  { id: "gpt-5.3-codex", label: "Codex 5.3" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "claude-opus-5", label: "Claude Opus 5" },
  { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash" },
];

/** Claude models offered for the subscription harness (model is optional — unset = the subscription default). */
export const CLAUDE_MODELS: readonly { id: string; label: string }[] = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

/**
 * 0050: model ids offered for the Codex harness. Starts at the
 * adapter's own deliberate default — GPT-5.6 models use Responses
 * Lite, which hides code-mode tools from the custom provider
 * (openai/codex#31894) — and grows only from spike evidence
 * (tests/codex-spike.integration.test.ts, 0050 phase 6).
 */
export const CODEX_MODELS: readonly { id: string; label: string }[] = [
  { id: "gpt-5.5", label: "GPT-5.5" },
];
