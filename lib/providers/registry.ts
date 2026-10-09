import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { createZhipu } from "zhipu-ai-provider";
import {
  PROVIDER_IDS,
  PROVIDER_KEY_ENV,
  PROVIDER_LABELS,
  staticModels,
  type ModelInfo,
  type ProviderId,
} from "./catalog";
import type { ChatRoute, Thinking } from "./route";

/**
 * 0021: providers are code, keys are env. One entry per provider: how
 * the in-process agent reaches it (an AI SDK LanguageModel) and how pi
 * reaches it (a pi ProviderConfig). claude/cursor have no entry — they
 * are subscription harnesses, never provider-routed (decision 1).
 *
 * Server-only (reads env, builds provider instances). Keys come through
 * `providerKey` alone, so the later move to the Secrets entity (2.2)
 * stays local to this file.
 */

const GLM_OPENAI_BASE = "https://api.z.ai/api/coding/paas/v4";
const GLM_ANTHROPIC_BASE = "https://api.z.ai/api/anthropic";
const GLOO_BASE = "https://platform.ai.gloo.com/ai/v2";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export function providerKey(provider: ProviderId): string | undefined {
  const value = process.env[PROVIDER_KEY_ENV[provider]];
  return value && value.trim() ? value : undefined;
}

/** Providers whose key is present — the only ones pickers offer. */
export function availableProviders(): Set<ProviderId> {
  return new Set(PROVIDER_IDS.filter((p) => providerKey(p)));
}

/**
 * Gloo rejects a tool without a `description` (422 "Field required",
 * verified live 2026-10-08); the AI SDK omits the field when a tool has
 * none. Fill it with the tool name. Pure; chat path only — harness-pi
 * already describes every host tool itself.
 */
export function fillToolDescriptions<T>(body: T): T {
  const b = body as { tools?: unknown };
  if (!b || typeof b !== "object" || !Array.isArray(b.tools)) return body;
  const tools = b.tools.map((t: unknown) => {
    const tool = t as { type?: string; function?: { name?: string; description?: string } };
    if (tool?.type !== "function" || !tool.function) return t;
    if (typeof tool.function.description === "string" && tool.function.description.trim()) return t;
    return { ...tool, function: { ...tool.function, description: tool.function.name ?? "tool" } };
  });
  return { ...(body as object), tools } as T;
}

let glm: ReturnType<typeof createZhipu> | null = null;
let gloo: ReturnType<typeof createOpenAICompatible> | null = null;
let openrouter: ReturnType<typeof createOpenAICompatible> | null = null;
/** Effort-injected twins, one per (provider, level) — see chatLanguageModel. */
const effortProviders = new Map<string, ReturnType<typeof createOpenAICompatible>>();

/**
 * 0021 amendment: a chat route's thinking level → the settings each
 * provider family actually takes (verified against the installed
 * packages, not memory):
 *
 * - GLM (zhipu-ai-provider): a `thinking: {type}` switch (GLM-4.5+) plus
 *   a leveled `reasoningEffort` (GLM-5.2+). "off" is a real disable.
 * - Gloo / OpenRouter (openai-compatible): OpenAI-style
 *   `reasoning_effort` in the request body; "off" is NOT sent — most
 *   effort-style models have no true off, and omitting keeps the
 *   model's default.
 */
export function zhipuThinkingSettings(thinking: Thinking | undefined) {
  if (!thinking) return undefined;
  if (thinking === "off") return { thinking: { type: "disabled" as const } };
  return { thinking: { type: "enabled" as const }, reasoningEffort: thinking };
}

/** The effort level an openai-compatible body carries (null = omit). */
export function effortLevel(thinking: Thinking | undefined): "low" | "medium" | "high" | null {
  return thinking === "low" || thinking === "medium" || thinking === "high" ? thinking : null;
}

/** The AI SDK model for chats, agent stages, and titles. */
export function chatLanguageModel(route: ChatRoute): LanguageModel {
  const effort = effortLevel(route.thinking);
  switch (route.provider) {
    case "glm":
      glm ??= createZhipu({ apiKey: providerKey("glm") ?? "", baseURL: GLM_OPENAI_BASE });
      return glm(route.model, zhipuThinkingSettings(route.thinking));
    case "gloo":
      if (effort) return effortCompatible("gloo", effort).chatModel(route.model);
      gloo ??= createOpenAICompatible({
        name: "gloo",
        baseURL: GLOO_BASE,
        apiKey: providerKey("gloo") ?? "",
        includeUsage: true,
        transformRequestBody: fillToolDescriptions,
      });
      return gloo.chatModel(route.model);
    case "openrouter":
      if (effort) return effortCompatible("openrouter", effort).chatModel(route.model);
      openrouter ??= createOpenAICompatible({
        name: "openrouter",
        baseURL: OPENROUTER_BASE,
        apiKey: providerKey("openrouter") ?? "",
        includeUsage: true,
        headers: { "HTTP-Referer": "https://sweatshop.internal.crussell.io", "X-Title": "sweatshop" },
      });
      return openrouter.chatModel(route.model);
  }
}

/** An openai-compatible twin whose bodies carry the effort level. */
function effortCompatible(provider: "gloo" | "openrouter", effort: "low" | "medium" | "high") {
  const key = `${provider}:${effort}`;
  const cached = effortProviders.get(key);
  if (cached) return cached;
  const base = provider === "gloo" ? fillToolDescriptions : undefined;
  const made = createOpenAICompatible({
    name: provider,
    baseURL: provider === "gloo" ? GLOO_BASE : OPENROUTER_BASE,
    apiKey: providerKey(provider) ?? "",
    includeUsage: true,
    ...(provider === "openrouter"
      ? { headers: { "HTTP-Referer": "https://sweatshop.internal.crussell.io", "X-Title": "sweatshop" } }
      : {}),
    // Body transform: compose the base (gloo's tool-description fill)
    // with the effort injection. The injection happens first so the
    // base transform still sees a plain body object.
    transformRequestBody: ((body: unknown) => {
      const injected = { ...(body as object), reasoning_effort: effort };
      return (base ? base(injected) : injected) as typeof body;
    }) as typeof base,
  });
  effortProviders.set(key, made);
  return made;
}

/** Shape of a pi ProviderConfig we produce (the subset we use). */
export interface PiProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  api: "anthropic-messages" | "openai-completions";
  models?: {
    id: string;
    name: string;
    reasoning: boolean;
    input: ("text" | "image")[];
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
  }[];
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * pi's provider config for one route (only the route's provider is
 * registered). Registering the model explicitly means pi never needs its
 * built-in catalog to know a Gloo or OpenRouter id. `model` must be in
 * `info` when given; GLM keeps today's Anthropic-surface wiring.
 */
export function piProviderConfig(provider: ProviderId, model: string, info?: ModelInfo): PiProviderConfig {
  const entry = {
    id: model,
    name: info?.label ?? model,
    reasoning: true,
    input: (info?.vision ? ["text", "image"] : ["text"]) as ("text" | "image")[],
    cost: ZERO_COST,
    contextWindow: info?.contextWindow ?? 128_000,
    maxTokens: info?.maxTokens ?? 32_000,
  };
  switch (provider) {
    case "glm":
      return {
        name: PROVIDER_LABELS.glm,
        baseUrl: GLM_ANTHROPIC_BASE,
        apiKey: providerKey("glm") ?? "",
        api: "anthropic-messages",
        models: [entry],
      };
    case "gloo":
      return {
        name: PROVIDER_LABELS.gloo,
        baseUrl: GLOO_BASE,
        apiKey: providerKey("gloo") ?? "",
        api: "openai-completions",
        models: [entry],
      };
    case "openrouter":
      return {
        name: PROVIDER_LABELS.openrouter,
        baseUrl: OPENROUTER_BASE,
        apiKey: providerKey("openrouter") ?? "",
        api: "openai-completions",
        models: [entry],
      };
  }
}

/** The static catalog entry for a model, if the provider has one. */
export function staticModelInfo(provider: ProviderId, model: string): ModelInfo | undefined {
  return staticModels(provider)?.find((m) => m.id === model);
}
