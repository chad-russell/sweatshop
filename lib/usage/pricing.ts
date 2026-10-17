/**
 * 0047: the price table and the cost function. Pure data + pure math —
 * no db, no Node imports; the workflow bundle imports the cost function
 * (capture happens inside steps) and the app imports the fetchers.
 *
 * Gloo prices come from the public `GET /platform/v2/models` (no key,
 * verified live 2026-10-17): exact per-1M rates for input/output plus
 * separate cache_read / cache_write segments and long-context tiers.
 * Those are LIST prices; a 6.5% platform fee applies to guarded
 * endpoints. Sweatshop calls the bare `/ai/v2/chat/completions` — which
 * fee surface that alias maps to is not documented, so the multiplier is
 * a column (`platform_fee`, default 1.0) calibrated once against Gloo
 * Studio's Usage dashboard (docs/0047 §calibration).
 */

export interface LongContextTier {
  /** Tier applies when input tokens >= this. */
  minPromptTokens: number;
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number | null;
}

export interface ModelPrice {
  provider: string;
  model: string;
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number | null;
  cacheWritePerM: number | null;
  longContext: LongContextTier[] | null;
  /** Multiplier on the computed cost (gloo guarded = 1.065, default 1.0). */
  platformFee: number;
  source: string;
  fetchedAt: number;
}

/** Usage numbers captured from one model call (SDK usage object shape). */
export interface UsageCounts {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
}

/** Rounds to cents at the storage boundary — never mid-computation. */
export function roundUsd(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * The cost formula (docs/0047 §cost model), all rates per 1M tokens:
 *
 *   fresh*input + cached*cache_read + output*output, * platform_fee
 *
 * - cached tokens are SUBTRACTED from fresh input (they are part of it,
 *   billed at their own rate); a missing cache_read rate treats them as
 *   fresh (never free — wrong-but-safe direction).
 * - long-context: the highest tier whose minPromptTokens <= input tokens
 *   replaces the base rates.
 */
export function computeCost(price: ModelPrice, usage: UsageCounts): number | null {
  const input = Math.max(0, usage.inputTokens);
  const cached = Math.max(0, Math.min(usage.cachedTokens, input));
  const output = Math.max(0, usage.outputTokens);
  const fresh = input - cached;

  let inputRate = price.inputPerM;
  let outputRate = price.outputPerM;
  let cacheRate = price.cacheReadPerM;
  if (price.longContext) {
    for (const tier of price.longContext) {
      if (input >= tier.minPromptTokens) {
        inputRate = tier.inputPerM;
        outputRate = tier.outputPerM;
        cacheRate = tier.cacheReadPerM;
      }
    }
  }

  const cost = (fresh * inputRate + cached * (cacheRate ?? inputRate) + output * outputRate) / 1e6;
  return roundUsd(cost * price.platformFee);
}

// --- Gloo /platform/v2/models ----------------------------------------------

const GLOO_MODELS_URL = "https://platform.ai.gloo.com/platform/v2/models";

interface GlooRate {
  rate_per_1m_tokens?: unknown;
}
interface GlooTieredRate {
  "5m"?: GlooRate;
  "1h"?: GlooRate;
  default?: GlooRate;
}

interface GlooLongContext {
  min_prompt_tokens?: unknown;
  input?: GlooRate;
  output?: GlooRate;
  cache_read?: GlooRate;
}

interface GlooModelV2 {
  id?: unknown;
  is_deprecated?: unknown;
  replacement_model?: unknown;
  pricing?: {
    input?: GlooRate;
    output?: GlooRate;
    cache_read?: GlooRate;
    cache_write?: GlooTieredRate;
    long_context?: GlooLongContext[];
  };
}

function rate1m(rate: GlooRate | undefined): number | null {
  const v = rate?.rate_per_1m_tokens;
  if (typeof v !== "string" && typeof v !== "number") return null;
  const n = typeof v === "string" ? Number.parseFloat(v) : v;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** cache_write tiers: Anthropic-style {5m, 1h}, or a flat {default}. We
 *  store the 5m rate (sweatshop never sets X-Cache-TTL today). */
function writeRate(tiered: GlooTieredRate | undefined): number | null {
  return rate1m(tiered?.["5m"]) ?? rate1m(tiered?.default);
}

function tiersOf(lcs: GlooLongContext[] | undefined): LongContextTier[] {
  const tier: LongContextTier[] = [];
  for (const lc of lcs ?? []) {
    const min = lc?.min_prompt_tokens;
    const li = rate1m(lc?.input);
    const lo = rate1m(lc?.output);
    if (typeof min === "number" && li !== null && lo !== null) {
      tier.push({ minPromptTokens: min, inputPerM: li, outputPerM: lo, cacheReadPerM: rate1m(lc?.cache_read) });
    }
  }
  return tier;
}

/**
 * Pure: the Gloo payload -> price rows keyed by the catalog id sweatshop
 * calls. A deprecated entry is PRICED at its replacement's rates (Gloo
 * reroutes silently — the price follows the money) but still keyed by
 * the id sweatshop actually sends.
 */
export function parseGlooPrices(payload: unknown, now = Date.now()): Map<string, ModelPrice> {
  const data = (payload as { data?: unknown })?.data;
  const out = new Map<string, ModelPrice>();
  if (!Array.isArray(data)) return out;
  const models = data as GlooModelV2[];
  const byId = new Map<string, GlooModelV2>();
  for (const m of models) if (typeof m.id === "string" && m.id) byId.set(m.id, m);

  const row = (id: string, p: NonNullable<GlooModelV2["pricing"]>): ModelPrice => {
    const tier = tiersOf(p.long_context);
    return {
      provider: "gloo",
      model: id,
      inputPerM: rate1m(p.input) ?? Number.NaN,
      outputPerM: rate1m(p.output) ?? Number.NaN,
      cacheReadPerM: rate1m(p.cache_read),
      cacheWritePerM: writeRate(p.cache_write),
      longContext: tier.length > 0 ? tier : null,
      platformFee: 1.0,
      source: "gloo-v2-models",
      fetchedAt: now,
    };
  };

  for (const m of models) {
    if (typeof m.id !== "string" || !m.id || !m.pricing) continue;
    if (rate1m(m.pricing.input) === null || rate1m(m.pricing.output) === null) continue;
    if (m.is_deprecated === true && typeof m.replacement_model === "string") {
      const rep = byId.get(m.replacement_model)?.pricing;
      if (rep && rate1m(rep.input) !== null && rate1m(rep.output) !== null) {
        out.set(m.id, row(m.id, rep));
        continue;
      }
    }
    out.set(m.id, row(m.id, m.pricing));
  }
  return out;
}

export async function fetchGlooPrices(
  fetcher: typeof fetch = fetch,
): Promise<{ ok: true; prices: Map<string, ModelPrice> } | { ok: false; error: string }> {
  try {
    const res = await fetcher(GLOO_MODELS_URL, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { ok: false, error: `Gloo models: HTTP ${res.status}` };
    const prices = parseGlooPrices(await res.json());
    if (prices.size === 0) return { ok: false, error: "Gloo models: no priced entries" };
    return { ok: true, prices };
  } catch (err) {
    return { ok: false, error: `Gloo models: ${err instanceof Error ? err.message : String(err)}` };
  }
}
