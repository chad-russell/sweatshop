import { describe, expect, it } from "vitest";
import { generateText } from "ai";
import { chatLanguageModel } from "../lib/providers/registry";
import type { ChatRoute } from "../lib/providers/route";

/**
 * 0021 amendment, live check (the PI_SPIKE pattern): a chat route's
 * thinking level against the real endpoints. Opt-in —
 * `THINKING_SPIKE=1 npx vitest run tests/thinking-spike.integration.test.ts`
 * (env must be set INSIDE the container; each provider also needs its
 * key). Answers the two things the package docs cannot: does the Z.AI
 * coding surface honor thinking/reasoningEffort, and which Gloo models
 * accept reasoning_effort (a stray one 400s).
 */

const spike = (name: string, env: string, run: () => Promise<void>) =>
  it(name, { timeout: 120_000 }, async () => {
    if (process.env.THINKING_SPIKE !== "1" || !process.env[env]) return; // skipped
    await run();
  });
describe("chat thinking (live, opt-in)", () => {
  spike(
    "GLM: thinking high answers and reports reasoning on the coding surface",
    "ZAI_API_KEY",
    async () => {
      const route: ChatRoute = { provider: "glm", model: "glm-5.3", thinking: "high" };
      const result = await generateText({ model: chatLanguageModel(route), prompt: "What is 17*23? Think it through." });
      expect(result.text).toBeTruthy();
      console.log("[thinking-spike] glm high — reasoning parts:", result.reasoning?.length ?? 0);
    },
  );

  spike(
    "GLM: thinking off answers without reasoning",
    "ZAI_API_KEY",
    async () => {
      const route: ChatRoute = { provider: "glm", model: "glm-5.3", thinking: "off" };
      const result = await generateText({ model: chatLanguageModel(route), prompt: "Say hi in three words." });
      expect(result.text).toBeTruthy();
      console.log("[thinking-spike] glm off — reasoning parts:", result.reasoning?.length ?? 0);
    },
  );

  spike(
    "Gloo: gpt-6-sol accepts reasoning_effort",
    "GLOO_API_KEY",
    async () => {
      const route: ChatRoute = { provider: "gloo", model: "gloo-openai-gpt-6-sol", thinking: "high" };
      const result = await generateText({ model: chatLanguageModel(route), prompt: "What is 17*23? Think it through." });
      expect(result.text).toBeTruthy();
      console.log("[thinking-spike] gloo sol high — reasoning parts:", result.reasoning?.length ?? 0);
    },
  );

  spike(
    "Gloo: a claude model with reasoning_effort — documents what happens (may 400; that is the answer)",
    "GLOO_API_KEY",
    async () => {
      const route: ChatRoute = { provider: "gloo", model: "gloo-anthropic-claude-sonnet-5.5", thinking: "high" };
      try {
        const result = await generateText({ model: chatLanguageModel(route), prompt: "Say hi in three words." });
        console.log("[thinking-spike] gloo claude+effort — accepted, reasoning parts:", result.reasoning?.length ?? 0);
      } catch (err) {
        console.log("[thinking-spike] gloo claude+effort — REJECTED:", String(err).slice(0, 200));
      }
    },
  );
});
