import type { Db } from "../../db";
import { catalogFetchedAt, replaceProviderModels } from "../../db/providers";
import { replaceModelPrices } from "../../db/usage";
import type { ModelPrice } from "../usage/pricing";
import type { ModelInfo } from "./catalog";

/**
 * 0021 §2: OpenRouter's catalog — fetched from the public
 * `GET /api/v1/models`, cached in `provider_models`, refreshed at most
 * daily (or on demand from /settings). Only tool-capable models are kept:
 * every sweatshop surface is agentic.
 */

const MODELS_URL = "https://openrouter.ai/api/v1/models";
export const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface OpenRouterModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  supported_parameters?: unknown;
  architecture?: { input_modalities?: unknown; output_modalities?: unknown };
  top_provider?: { max_completion_tokens?: unknown };
  /** USD per token, as strings. Absent or "0" on :free variants. */
  pricing?: {
    prompt?: unknown;
    completion?: unknown;
    input_cache_read?: unknown;
  };
}

/** Pure: the API payload → our catalog rows (tool-capable, text-out). */
export function parseOpenRouterModels(payload: unknown): ModelInfo[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const out: ModelInfo[] = [];
  for (const raw of data as OpenRouterModel[]) {
    if (typeof raw?.id !== "string" || !raw.id) continue;
    const params = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : [];
    if (!params.includes("tools")) continue;
    const outputs = raw.architecture?.output_modalities;
    if (Array.isArray(outputs) && !outputs.includes("text")) continue;
    const inputs = raw.architecture?.input_modalities;
    const context = typeof raw.context_length === "number" && raw.context_length > 0 ? raw.context_length : 128_000;
    const maxOut = raw.top_provider?.max_completion_tokens;
    out.push({
      id: raw.id,
      label: typeof raw.name === "string" && raw.name ? raw.name : raw.id,
      contextWindow: context,
      maxTokens: typeof maxOut === "number" && maxOut > 0 ? maxOut : Math.min(32_000, context),
      ...(Array.isArray(inputs) && inputs.includes("image") ? { vision: true } : {}),
      // OpenRouter declares per-model whether it takes reasoning params.
      ...(params.includes("reasoning") ? { reasoning: "effort" as const } : {}),
    });
  }
  return out;
}

/** USD-per-token string → per-1M rate. Zero, missing, and non-numeric
 *  values are "no price" (the :free variants publish "0"). */
function perM(v: unknown): number | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const n = typeof v === "string" ? Number.parseFloat(v) : v;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n * 1e6;
}

/**
 * Pure: the same `/api/v1/models` payload → price rows. A model is kept
 * only when both prompt and completion parse to a finite rate above
 * zero. Cache read is optional; a missing or zero cache price stays null
 * (cached tokens billed as fresh — never guessed free).
 */
export function parseOpenRouterPrices(payload: unknown, now = Date.now()): ModelPrice[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const out: ModelPrice[] = [];
  for (const raw of data as OpenRouterModel[]) {
    if (typeof raw?.id !== "string" || !raw.id) continue;
    const inputPerM = perM(raw.pricing?.prompt);
    const outputPerM = perM(raw.pricing?.completion);
    if (inputPerM === null || outputPerM === null) continue;
    out.push({
      provider: "openrouter",
      model: raw.id,
      inputPerM,
      outputPerM,
      cacheReadPerM: perM(raw.pricing?.input_cache_read),
      cacheWritePerM: null,
      longContext: null,
      platformFee: 1,
      source: "openrouter-catalog",
      fetchedAt: now,
    });
  }
  return out;
}

export async function refreshOpenRouterCatalog(
  db: Db,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  try {
    const res = await fetcher(MODELS_URL, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { ok: false, error: `OpenRouter models: HTTP ${res.status}` };
    const payload = await res.json();
    const models = parseOpenRouterModels(payload);
    if (models.length === 0) return { ok: false, error: "OpenRouter returned no tool-capable models" };
    replaceProviderModels(db, "openrouter", models);
    // Prices ride the same payload. A persist failure keeps the previous
    // rows and does not fail the catalog refresh.
    try {
      replaceModelPrices(db, "openrouter-catalog", parseOpenRouterPrices(payload));
    } catch (err) {
      console.error("[usage] openrouter prices persist failed", err);
    }
    return { ok: true, count: models.length };
  } catch (err) {
    return { ok: false, error: `OpenRouter models: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Refresh when never fetched or older than a day; failures keep the old cache. */
export async function ensureOpenRouterCatalog(db: Db, now = Date.now()): Promise<void> {
  const at = catalogFetchedAt(db, "openrouter");
  if (at !== null && now - at < CATALOG_MAX_AGE_MS) return;
  await refreshOpenRouterCatalog(db);
}
