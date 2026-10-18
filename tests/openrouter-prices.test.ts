import { describe, expect, it } from "vitest";
import { parseOpenRouterPrices } from "@/lib/providers/openrouter";

const payload = {
  data: [
    {
      id: "anthropic/claude-sonnet",
      pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003" },
    },
    {
      id: "meta/llama:free",
      pricing: { prompt: "0", completion: "0" },
    },
    {
      id: "no/price",
      name: "Missing pricing",
    },
    {
      id: "bad/prompt",
      pricing: { prompt: "nope", completion: "0.000001" },
    },
  ],
};

describe("0047 parseOpenRouterPrices", () => {
  it("converts per-token strings to per-1M rates and skips free or missing prices", () => {
    const prices = parseOpenRouterPrices(payload, 50);
    expect(prices.map((p) => p.model)).toEqual(["anthropic/claude-sonnet"]);
    expect(prices[0]).toMatchObject({
      provider: "openrouter",
      model: "anthropic/claude-sonnet",
      inputPerM: 3,
      outputPerM: 15,
      cacheReadPerM: 0.3,
      cacheWritePerM: null,
      source: "openrouter-catalog",
      fetchedAt: 50,
      platformFee: 1,
    });
  });

  it("returns nothing for a payload without a data array", () => {
    expect(parseOpenRouterPrices(null)).toEqual([]);
    expect(parseOpenRouterPrices({ data: "nope" })).toEqual([]);
  });
});
