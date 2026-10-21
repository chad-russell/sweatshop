import type { LanguageModelV4Usage } from "@ai-sdk/provider";

/** Gloo's Anthropic models require an explicit opt-in. Other families
 * cache implicitly; do not send an Anthropic TTL on those requests. */
export function glooCacheHeaders(model: string): Record<string, string> {
  return model.startsWith("gloo-anthropic-") ? { "X-Cache-TTL": "5m" } : {};
}

interface GlooUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  prompt_tokens_details?: {
    cached_tokens?: number | null;
    cache_write_tokens?: number | null;
  } | null;
  completion_tokens_details?: { reasoning_tokens?: number | null } | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Convert BEFORE the Workflow SDK checkpoints usage. The default SDK
 * converter drops cache writes and doesn't read Anthropic aliases.
 * Gloo's OpenAI-compatible prompt_tokens includes both cache segments. */
export function convertGlooUsage(usage: GlooUsage | null | undefined): LanguageModelV4Usage {
  if (!usage) {
    return {
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    };
  }
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  const read = usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0;
  const write = usage.prompt_tokens_details?.cache_write_tokens ?? usage.cache_creation_input_tokens ?? 0;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;
  return {
    inputTokens: { total: input, noCache: Math.max(0, input - read - write), cacheRead: read, cacheWrite: write },
    outputTokens: { total: output, text: Math.max(0, output - reasoning), reasoning },
    raw: { ...usage },
  };
}
