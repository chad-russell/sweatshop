import { createZhipu } from "zhipu-ai-provider";

/**
 * The Z.AI GLM coding plan (OpenAI-compatible endpoint). One shared
 * provider instance for every consumer: the eve agent's dynamic model
 * resolver and the run_ticket WorkflowAgent phases.
 */
const zai = createZhipu({
  apiKey: process.env.ZAI_API_KEY ?? "",
  baseURL: "https://api.z.ai/api/coding/paas/v4",
});

/** A LanguageModel on the coding-plan endpoint, by endpoint model id. */
export function zaiModel(id: string) {
  return zai(id);
}

/**
 * Models the eve chat can run on. Verified against the live endpoint
 * (2026-10-07): glm-5.3 and glm-5.3-flash answer 200; the `[1m]` 1M-context
 * suffix is Claude-Code/Anthropic-surface only (400 Unknown Model here);
 * glm-5.3-flashx is not on the plan (429). Older ids (5.2/5.1 → 5.3,
 * 4.7 → 5.3-flash) are server-side aliases, so they are not offered.
 *
 * contextWindowTokens is the conservative coding-plan default (128k).
 * zhipu models are not in the AI Gateway catalog, so eve cannot resolve
 * the window itself — compaction sizing needs the explicit value. A
 * low estimate only compacts a little early; never set it above the
 * endpoint's real limit.
 */
export interface ChatModel {
  /** Endpoint model id, e.g. "glm-5.3-flash". */
  id: string;
  /** Short UI label. */
  label: string;
  /** One-line UI hint. */
  description: string;
  /** Conservative context window for compaction sizing. */
  contextWindowTokens: number;
}

export const CHAT_MODELS: readonly ChatModel[] = [
  {
    id: "glm-5.3-flash",
    label: "GLM 5.3 Flash",
    description: "Fast — the default",
    contextWindowTokens: 128_000,
  },
  {
    id: "glm-5.3",
    label: "GLM 5.3",
    description: "Frontier reasoning",
    contextWindowTokens: 128_000,
  },
];

export const DEFAULT_CHAT_MODEL: ChatModel = CHAT_MODELS[0];

/** Look up a chat model by endpoint id; undefined when unknown. */
export function findChatModel(id: string | null | undefined): ChatModel | undefined {
  return CHAT_MODELS.find((model) => model.id === id);
}

/**
 * Resolve a requested model id (e.g. from the x-sweatshop-model channel
 * attribute) to a known chat model, falling back to the default rather
 * than failing the turn — the picker only offers known ids, so a miss
 * means a stale client or a manual header, not a user choice to honor.
 */
export function resolveChatModel(id: string | null | undefined): ChatModel {
  return findChatModel(id) ?? DEFAULT_CHAT_MODEL;
}

/**
 * Shared flash factory (0004 Path B): raw WorkflowAgent phases run on
 * the default chat model.
 */
export function glmFlash() {
  return zaiModel(DEFAULT_CHAT_MODEL.id);
}
