import type { LanguageModelV4 } from "@ai-sdk/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertGlooUsage, glooCacheHeaders } from "@/lib/providers/gloo";
import { chatLanguageModel, piProviderConfig } from "@/lib/providers/registry";
import { normalizeUsage } from "@/lib/usage/pricing";

afterEach(() => vi.unstubAllGlobals());

const modelId = "gloo-anthropic-claude-opus-5.5";
const options = { prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }] };
const wireUsage = {
  prompt_tokens: 1_000,
  completion_tokens: 50,
  prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 200 },
  completion_tokens_details: { reasoning_tokens: 10 },
};

describe("0057 Gloo caching", () => {
  it("opts in only Anthropic models, including pi", () => {
    expect(glooCacheHeaders(modelId)).toEqual({ "X-Cache-TTL": "5m" });
    expect(piProviderConfig("gloo", modelId).headers).toEqual({ "X-Cache-TTL": "5m" });
    expect(glooCacheHeaders("gloo-openai-gpt-6-sol")).toEqual({});
    expect(piProviderConfig("gloo", "gloo-google-gemini-3.5-flash").headers).toEqual({});
    expect(piProviderConfig("openrouter", "anthropic/claude-opus-5.5").headers).toBeUndefined();
  });

  it("maps the standard wire shape with inclusive input and disjoint cache segments", () => {
    const usage = convertGlooUsage(wireUsage);
    expect(usage.inputTokens).toEqual({ total: 1_000, noCache: 200, cacheRead: 600, cacheWrite: 200 });
    expect(normalizeUsage(usage)).toEqual({
      inputTokens: 1_000, cachedTokens: 600, cacheWriteTokens: 200, outputTokens: 50, reasoningTokens: 10,
    });
    expect(usage.raw).toEqual(wireUsage);
  });

  it("accepts Anthropic aliases without adding them to prompt_tokens again", () => {
    expect(convertGlooUsage({
      prompt_tokens: 1_000, completion_tokens: 50,
      cache_read_input_tokens: 600, cache_creation_input_tokens: 200,
    }).inputTokens).toEqual({ total: 1_000, noCache: 200, cacheRead: 600, cacheWrite: 200 });
  });

  it("standard fields win over aliases, even for zero", () => {
    expect(convertGlooUsage({
      ...wireUsage, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      cache_read_input_tokens: 600, cache_creation_input_tokens: 200,
    }).inputTokens).toMatchObject({ cacheRead: 0, cacheWrite: 0, noCache: 1_000 });
  });

  it("keeps absent usage unknown", () => {
    expect(convertGlooUsage(null).inputTokens.total).toBeUndefined();
    expect(convertGlooUsage(undefined).outputTokens.total).toBeUndefined();
  });

  it.each([undefined, "high"] as const)("sends the TTL and preserves tool/effort transforms (%s)", async (thinking) => {
    const fetchMock = vi.fn(async () => Response.json({
      id: "test", model: modelId, created: 1,
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: wireUsage,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const model = chatLanguageModel({ provider: "gloo", model: modelId, thinking }) as LanguageModelV4;
    const result = await model.doGenerate({
      ...options,
      tools: [{ type: "function", name: "ping", inputSchema: { type: "object", properties: {} } }],
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://platform.ai.gloo.com/ai/v2/chat/completions");
    expect(new Headers(init.headers).get("X-Cache-TTL")).toBe("5m");
    const body = JSON.parse(init.body as string);
    expect(body.tools[0].function.description).toBe("ping");
    expect(body.reasoning_effort).toBe(thinking);
    expect(result.usage.inputTokens.cacheWrite).toBe(200);
    expect(result.usage.inputTokens.cacheRead).toBe(600);
  });

  it("does not opt other Gloo families into explicit caching", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: wireUsage,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const model = chatLanguageModel({ provider: "gloo", model: "gloo-openai-gpt-6-sol", thinking: "high" }) as LanguageModelV4;
    await model.doGenerate(options);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).has("X-Cache-TTL")).toBe(false);
  });

  it("preserves alias usage from the final SSE chunk", async () => {
    const chunks = [
      { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: {
        prompt_tokens: 1_000, completion_tokens: 50,
        cache_read_input_tokens: 600, cache_creation_input_tokens: 200,
      } },
    ];
    const fetchMock = vi.fn(async () => new Response(
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const model = chatLanguageModel({ provider: "gloo", model: modelId }) as LanguageModelV4;
    const { stream } = await model.doStream(options);
    const reader = stream.getReader();
    let finish;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.type === "finish") finish = value;
      expect(value.type).not.toBe("error");
    }
    expect(normalizeUsage(finish?.usage)).toMatchObject({
      inputTokens: 1_000, cachedTokens: 600, cacheWriteTokens: 200, outputTokens: 50,
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).stream_options.include_usage).toBe(true);
  });
});
