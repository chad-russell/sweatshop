import { describe, expect, it } from "vitest";

/**
 * 0005 Phase A spike — pi (HarnessAgent + createPi) on the GLM coding
 * plan via the Anthropic Messages surface, driving one of our
 * provisioned sandbox containers. Not part of the normal gate:
 *   PI_SPIKE=1 npx vitest run tests/pi-spike.integration.test.ts
 * Uses the REAL db (project + git credentials) and ZAI_API_KEY from env.
 */
const run = process.env.PI_SPIKE === "1" ? describe : describe.skip;

run("pi harness spike (0005 Phase A)", () => {
  it(
    "pi performs a real edit+commit on GLM through our sandbox",
    async () => {
      process.env.SWEATSHOP_DB = "data/sweatshop.db";
      const apiKey = process.env.ZAI_API_KEY;
      expect(apiKey, "ZAI_API_KEY must be set").toBeTruthy();

      const { provisionProjectSandbox } = await import(
        "../lib/sandboxes/provision"
      );
      const { toSandboxSession } = await import(
        "../lib/sandboxes/ai-sdk-adapter"
      );
      const { HarnessAgent } = await import("@ai-sdk/harness/agent");
      const { createPi } = await import("@ai-sdk/harness-pi");

      const sb = await provisionProjectSandbox("spike");
      const sandboxSession = toSandboxSession(sb);

      const pi = createPi({
        providers: {
          "zai-glm": {
            name: "Z.AI GLM Coding Plan",
            baseUrl: "https://api.z.ai/api/anthropic",
            apiKey,
            api: "anthropic",
          },
        },
        thinkingLevel: "low",
      });
      const agent = new HarnessAgent({
        harness: pi,
        id: "spike-pi",
        model: "zai-glm/glm-5.3-flash",
      });

      const session = await agent.createSession({ sandboxSession });
      try {
        const result = await agent.generate({
          session,
          prompt:
            "In /workspace/scratch: create a file named pi-spike.txt " +
            "containing the text 'pi harness verified', then commit it on " +
            "a new branch pi/spike. Do not push.",
        });
        console.log("PI RESULT:", result.text.slice(0, 400));

        // Transcript-level evidence: the sandbox state itself.
        const check = await sb.run(
          "cd /workspace/scratch && git branch --show-current && " +
            "cat pi-spike.txt && git log --oneline -1",
        );
        console.log("SANDBOX CHECK:", JSON.stringify(check).slice(0, 300));
        expect(check.exitCode).toBe(0);
        expect(check.stdout).toContain("pi/spike");
        expect(check.stdout).toContain("pi harness verified");
      } finally {
        await session.destroy();
        await sb.remove();
      }
    },
    600_000,
  );
});
