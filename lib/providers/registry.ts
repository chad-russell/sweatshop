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
import { convertGlooUsage, glooCacheHeaders } from "./gloo";

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

/** 0090 §2: the URL a connector [Test] fetches — a raw models-list
 * request against the provider's OpenAI-compatible surface. */
export function providerModelsUrl(provider: ProviderId): string {
  switch (provider) {
    case "glm":
      return `${GLM_OPENAI_BASE}/models`;
    case "gloo":
      return `${GLOO_BASE}/models`;
    case "openrouter":
      return `${OPENROUTER_BASE}/models`;
  }
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
const glooProviders = new Map<string, ReturnType<typeof createOpenAICompatible>>();
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

/**
 * OpenRouter's attribution headers. The referer says where this
 * deployment's calls come from: `SWEATSHOP_PUBLIC_ORIGIN` (this app's
 * public origin — the same var the preview "not running" page links
 * back to), defaulting to the local dev origin when unset. X-Title
 * stays the product name.
 */
export function openRouterHeaders(): Record<string, string> {
  return {
    "HTTP-Referer": process.env.SWEATSHOP_PUBLIC_ORIGIN?.trim() || "http://localhost:3000",
    "X-Title": "sweatshop",
  };
}

/** The AI SDK model for chats, agent stages, and titles. */
export function chatLanguageModel(route: ChatRoute): LanguageModel {
  const effort = effortLevel(route.thinking);
  switch (route.provider) {
    case "glm":
      glm ??= createZhipu({ apiKey: providerKey("glm") ?? "", baseURL: GLM_OPENAI_BASE });
      return glm(route.model, zhipuThinkingSettings(route.thinking));
    case "gloo":
      return glooProvider(route.model, effort).chatModel(route.model);
    case "openrouter":
      if (effort) return effortCompatible("openrouter", effort).chatModel(route.model);
      openrouter ??= createOpenAICompatible({
        name: "openrouter",
        baseURL: OPENROUTER_BASE,
        apiKey: providerKey("openrouter") ?? "",
        includeUsage: true,
        headers: openRouterHeaders(),
      });
      return openrouter.chatModel(route.model);
  }
}

/** TTL is model-family specific, and must survive effort configuration. */
function glooProvider(model: string, effort: ReturnType<typeof effortLevel>) {
  const headers = glooCacheHeaders(model);
  const key = `${headers["X-Cache-TTL"] ?? "implicit"}:${effort ?? "default"}`;
  let provider = glooProviders.get(key);
  if (!provider) {
    provider = createOpenAICompatible({
      name: "gloo",
      baseURL: GLOO_BASE,
      apiKey: providerKey("gloo") ?? "",
      includeUsage: true,
      headers,
      convertUsage: convertGlooUsage,
      transformRequestBody: (body) => fillToolDescriptions(
        effort ? { ...body, reasoning_effort: effort } : body,
      ),
    });
    glooProviders.set(key, provider);
  }
  return provider;
}

/** An openai-compatible twin whose bodies carry the effort level. */
function effortCompatible(provider: "openrouter", effort: "low" | "medium" | "high") {
  const key = `${provider}:${effort}`;
  const cached = effortProviders.get(key);
  if (cached) return cached;
  const made = createOpenAICompatible({
    name: provider,
    baseURL: OPENROUTER_BASE,
    apiKey: providerKey(provider) ?? "",
    includeUsage: true,
    headers: openRouterHeaders(),
    transformRequestBody: (body) => ({ ...body, reasoning_effort: effort }),
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
  headers?: Record<string, string>;
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
        headers: glooCacheHeaders(model),
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
