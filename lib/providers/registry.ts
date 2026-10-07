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

/** The AI SDK model for chats, agent stages, and titles. */
export function chatLanguageModel(provider: ProviderId, model: string): LanguageModel {
  switch (provider) {
    case "glm":
      glm ??= createZhipu({ apiKey: providerKey("glm") ?? "", baseURL: GLM_OPENAI_BASE });
      return glm(model);
    case "gloo":
      gloo ??= createOpenAICompatible({
        name: "gloo",
        baseURL: GLOO_BASE,
        apiKey: providerKey("gloo") ?? "",
        includeUsage: true,
        transformRequestBody: fillToolDescriptions,
      });
      return gloo.chatModel(model);
    case "openrouter":
      openrouter ??= createOpenAICompatible({
        name: "openrouter",
        baseURL: OPENROUTER_BASE,
        apiKey: providerKey("openrouter") ?? "",
        includeUsage: true,
        headers: { "HTTP-Referer": "https://sweatshop.internal.crussell.io", "X-Title": "sweatshop" },
      });
      return openrouter.chatModel(model);
  }
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
