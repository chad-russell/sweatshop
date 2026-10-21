import { describe, expect, it } from "vitest";
import {
  computeCost,
  addUsage,
  normalizeUsage,
  parseGlooPrices,
  readSliceUsage,
  type ModelPrice,
} from "@/lib/usage/pricing";

const price = (over: Partial<ModelPrice> = {}): ModelPrice => ({
  provider: "gloo",
  model: "test-model",
  inputPerM: 2,
  outputPerM: 10,
  cacheReadPerM: 0.2,
  cacheWritePerM: 2.5,
  longContext: null,
  platformFee: 1,
  source: "test",
  fetchedAt: 0,
  ...over,
});

describe("0047 computeCost", () => {
  it("prices fresh input, cached input, and output at their own rates", () => {
    const cost = computeCost(price(), { inputTokens: 1_000_000, cachedTokens: 600_000, outputTokens: 100_000 });
    // fresh 400k*2 + cached 600k*0.2 + output 100k*10 = 0.8 + 0.12 + 1.0
    expect(cost).toBeCloseTo(1.92, 10);
  });

  it("treats cached as fresh when the model has no cache_read rate (never free)", () => {
    const cost = computeCost(price({ cacheReadPerM: null }), { inputTokens: 1_000_000, cachedTokens: 600_000, outputTokens: 0 });
    expect(cost).toBeCloseTo(2, 10);
  });

  it("bills disjoint cache writes at the five-minute rate, not fresh input", () => {
    expect(computeCost(price(), {
      inputTokens: 1_000_000, cachedTokens: 600_000, cacheWriteTokens: 200_000, outputTokens: 100_000,
    })).toBe(2.02); // 0.4 fresh + 0.12 read + 0.5 write + 1 output
  });

  it("falls back to input pricing when the write rate is missing", () => {
    expect(computeCost(price({ cacheWritePerM: null }), {
      inputTokens: 1_000_000, cachedTokens: 0, cacheWriteTokens: 1_000_000, outputTokens: 0,
    })).toBe(2);
  });

  it("clamps writes to input remaining after reads", () => {
    expect(computeCost(price(), {
      inputTokens: 1_000_000, cachedTokens: 600_000, cacheWriteTokens: 2_000_000, outputTokens: 0,
    })).toBe(1.12);
  });

  it("uses long-context write rates", () => {
    expect(computeCost(price({ longContext: [
      { minPromptTokens: 200_000, inputPerM: 4, outputPerM: 15, cacheReadPerM: 0.4, cacheWritePerM: 5 },
    ] }), {
      inputTokens: 300_000, cachedTokens: 100_000, cacheWriteTokens: 100_000, outputTokens: 0,
    })).toBe(0.94);
  });

  it("applies the platform fee multiplier after summing", () => {
    const cost = computeCost(price({ platformFee: 1.065 }), { inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 0 });
    expect(cost).toBeCloseTo(2.13, 2);
  });

  it("picks the long-context tier when input crosses minPromptTokens", () => {
    const p = price({
      longContext: [
        { minPromptTokens: 200_000, inputPerM: 4, outputPerM: 15, cacheReadPerM: 0.4 },
      ],
    });
    const under = computeCost(p, { inputTokens: 100_000, cachedTokens: 0, outputTokens: 100_000 });
    expect(under).toBeCloseTo(1.2, 10); // 100k*2/1M + 100k*10/1M
    const over = computeCost(p, { inputTokens: 300_000, cachedTokens: 0, outputTokens: 100_000 });
    expect(over).toBeCloseTo(2.7, 10); // 300k*4/1M + 100k*15/1M
  });

  it("clamps cached above input (cached is a subset of input)", () => {
    // cached clamps to input=100, all cached -> 100*0.2/1M, rounded to cents = 0
    const cost = computeCost(price(), { inputTokens: 100, cachedTokens: 5_000, outputTokens: 0 });
    expect(cost).toBe(0);
  });

  it("rounds to cents", () => {
    const cost = computeCost(price({ inputPerM: 0.333333 }), { inputTokens: 123_457, cachedTokens: 0, outputTokens: 0 });
    expect(cost).toBeCloseTo(Math.round((123_457 * 0.333333 / 1e6) * 100) / 100, 10);
  });
});

describe("0047 parseGlooPrices", () => {
  const payload = {
    data: [
      {
        id: "gloo-test-opus",
        pricing: {
          input: { rate_per_1m_tokens: "4.000000" },
          output: { rate_per_1m_tokens: "20.000000" },
          cache_read: { rate_per_1m_tokens: "0.200000" },
          cache_write: { "5m": { rate_per_1m_tokens: "5.000000" }, "1h": { rate_per_1m_tokens: "8.000000" } },
          long_context: [
            {
              min_prompt_tokens: 200_000,
              input: { rate_per_1m_tokens: "6.000000" },
              output: { rate_per_1m_tokens: "22.500000" },
              cache_read: { rate_per_1m_tokens: "0.600000" },
              cache_write: { "5m": { rate_per_1m_tokens: "7.500000" }, "1h": { rate_per_1m_tokens: "12.000000" } },
            },
          ],
        },
      },
      {
        id: "gloo-old-sonnet",
        is_deprecated: true,
        replacement_model: "gloo-new-sonnet",
        pricing: {
          input: { rate_per_1m_tokens: "3.000000" },
          output: { rate_per_1m_tokens: "15.000000" },
        },
      },
      {
        id: "gloo-new-sonnet",
        pricing: {
          input: { rate_per_1m_tokens: "2.000000" },
          output: { rate_per_1m_tokens: "10.000000" },
          cache_read: { rate_per_1m_tokens: "0.100000" },
        },
      },
      {
        id: "gloo-gemini-style",
        pricing: {
          input: { rate_per_1m_tokens: "1.250000" },
          output: { rate_per_1m_tokens: "10.000000" },
          cache_read: { rate_per_1m_tokens: "0.125000" },
          cache_write: { default: { rate_per_1m_tokens: "0.375000" } },
        },
      },
      {
        id: "gloo-unpriced",
        pricing: { input: {} },
      },
    ],
  };

  it("extracts exact rates, tiered cache_write (5m wins), and long-context tiers", () => {
    const prices = parseGlooPrices(payload, 1234);
    const opus = prices.get("gloo-test-opus")!;
    expect(opus.inputPerM).toBe(4);
    expect(opus.outputPerM).toBe(20);
    expect(opus.cacheReadPerM).toBe(0.2);
    expect(opus.cacheWritePerM).toBe(5); // 5m tier
    expect(opus.longContext).toEqual([
      { minPromptTokens: 200_000, inputPerM: 6, outputPerM: 22.5, cacheReadPerM: 0.6, cacheWritePerM: 7.5 },
    ]);
    expect(opus.source).toBe("gloo-v2-models");
    expect(opus.fetchedAt).toBe(1234);
    expect(opus.platformFee).toBe(1.065); // our endpoint is a guarded alias
  });

  it("maps a flat cache_write default tier", () => {
    const gemini = parseGlooPrices(payload).get("gloo-gemini-style")!;
    expect(gemini.cacheWritePerM).toBe(0.375);
  });

  it("prices a deprecated id at its replacement's rates, keyed by the called id", () => {
    const prices = parseGlooPrices(payload);
    const old = prices.get("gloo-old-sonnet")!;
    expect(old.inputPerM).toBe(2); // replacement's rate
    expect(old.model).toBe("gloo-old-sonnet"); // keyed by what sweatshop calls
    expect(prices.get("gloo-new-sonnet")!.inputPerM).toBe(2);
  });

  it("skips entries without usable rates", () => {
    expect(parseGlooPrices(payload).has("gloo-unpriced")).toBe(false);
  });

  it("returns empty on malformed payloads", () => {
    expect(parseGlooPrices(null).size).toBe(0);
    expect(parseGlooPrices({}).size).toBe(0);
    expect(parseGlooPrices({ data: "nope" }).size).toBe(0);
  });
});

describe("0047 usage normalization", () => {
  it("reads LanguageModelUsage cache-read, cache-write and reasoning", () => {
    expect(
      normalizeUsage({
        inputTokens: 100,
        outputTokens: 50,
        inputTokenDetails: { cacheReadTokens: 40, cacheWriteTokens: 7, noCacheTokens: 60 },
        outputTokenDetails: { reasoningTokens: 10, textTokens: 40 },
      }),
    ).toEqual({ inputTokens: 100, cachedTokens: 40, cacheWriteTokens: 7, outputTokens: 50, reasoningTokens: 10 });
  });

  it("reads nested LanguageModelV4Usage (harness finish-step)", () => {
    expect(
      normalizeUsage({
        inputTokens: { total: 80, noCache: 70, cacheRead: 10, cacheWrite: 3 },
        outputTokens: { total: 20, text: 15, reasoning: 5 },
      }),
    ).toEqual({ inputTokens: 80, cachedTokens: 10, cacheWriteTokens: 3, outputTokens: 20, reasoningTokens: 5 });
  });

  it("sums writes and accepts counts from pre-0055 workflows", () => {
    expect(addUsage(
      { inputTokens: 10, cachedTokens: 0, outputTokens: 2 },
      { inputTokens: 20, cachedTokens: 5, cacheWriteTokens: 7, outputTokens: 3 },
    )).toMatchObject({ inputTokens: 30, cachedTokens: 5, cacheWriteTokens: 7, outputTokens: 5 });
  });

  it("prefers step usage over the stripped stream totalUsage", () => {
    const counts = readSliceUsage({
      steps: [
        {
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            inputTokenDetails: { cacheReadTokens: 25, cacheWriteTokens: 10 },
            outputTokenDetails: { reasoningTokens: 10 },
          },
        },
      ],
      totalUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });
    expect(counts.cachedTokens).toBe(25);
    expect(counts.cacheWriteTokens).toBe(10);
    expect(counts.reasoningTokens).toBe(10);
  });
});
