import { describe, expect, it } from "vitest";
import type { PiRoute } from "../lib/providers/route";
import { driveHarnessTurn } from "./helpers/drive-harness";

/**
 * pi live spike (0005 Phase A; 0021: through the real route path) — the
 * production `buildHarnessAgent` drives one turn of pi in a throwaway
 * bare sandbox, on each provider whose key is set. Proves pi reaches
 * GLM (Anthropic surface), Gloo and OpenRouter (openai-completions)
 * through a route, and that a host tool round-trips (on Gloo that needs
 * the tool-description fix). Not part of the normal gate:
 *   PI_SPIKE=1 npx vitest run tests/pi-spike.integration.test.ts
 * Needs podman (the host socket) and the provider keys in env.
 * PI_SPIKE_ROUTES (comma list of glm|gloo|openrouter) narrows it.
 */
const run = process.env.PI_SPIKE === "1" ? describe : describe.skip;

const ROUTES: Record<string, PiRoute> = {
  glm: { harness: "pi", provider: "glm", model: "glm-5.3-flash" },
  gloo: { harness: "pi", provider: "gloo", model: "gloo-anthropic-claude-haiku-4.5" },
  openrouter: { harness: "pi", provider: "openrouter", model: "anthropic/claude-haiku-4.5" },
};
const KEY_ENV = { glm: "ZAI_API_KEY", gloo: "GLOO_API_KEY", openrouter: "OPENROUTER_API_KEY" } as const;
const wanted = (process.env.PI_SPIKE_ROUTES ?? "glm,gloo,openrouter").split(",").map((s) => s.trim());

run("pi harness spike (0021 routes)", () => {
  for (const name of wanted) {
    const route = ROUTES[name];
    if (!route) continue;
    it(
      `pi on ${name} edits a file and calls a host tool`,
      async () => {
        expect(process.env[KEY_ENV[route.provider]], `${KEY_ENV[route.provider]} must be set`).toBeTruthy();
        const { podmanProvider } = await import("../lib/sandboxes/provider");
        const { toSandboxSession } = await import("../lib/sandboxes/ai-sdk-adapter");
        const { buildHarnessAgent } = await import("../workflows/machines/harness-agent");
        const { staticModelInfo } = await import("../lib/providers/registry");
        const { tool } = await import("ai");
        const { z } = await import("zod");

        const root = "/work/pi-spike";
        const sb = await podmanProvider.create({ projectId: null, namePrefix: `pi-spike-${name}`, root });
        let pinged = "";
        try {
          const agent = buildHarnessAgent({
            route,
            sessionId: `spike-${name}`,
            modelInfo: staticModelInfo(route.provider, route.model),
            // No description on purpose: Gloo 422s without the fix.
            tools: {
              record_word: tool({
                inputSchema: z.object({ word: z.string() }),
                execute: async ({ word }) => {
                  pinged = word;
                  return { ok: true };
                },
              }),
            },
          });
          // The production grain: one semantic step per call, driven to the end.
          const end = await driveHarnessTurn({
            agent,
            sandboxSession: toSandboxSession(sb, root),
            sessionId: `spike-${name}`,
            prompt:
              "Create a file named spike.txt in the current directory containing exactly 'pi ok', " +
              "then call the record_word tool with word 'banana'. Reply 'done' when finished.",
          });
          console.log(`PI[${name}]`, JSON.stringify(end), "| tool word:", pinged);
          expect(end.status).not.toBe("failed");
          const check = await sb.run("cat spike.txt", undefined, root);
          expect(check.stdout).toContain("pi ok");
          expect(pinged).toBe("banana");
        } finally {
          await podmanProvider.destroy(sb.ref);
        }
      },
      600_000,
    );
  }
});
