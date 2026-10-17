import { describe, expect, it } from "vitest";
import { driveHarnessTurn } from "./helpers/drive-harness";

/**
 * 0006 bridge spike, on the real 0013 path — Claude Code harness adapter
 * against a disposable `localhost/sweatshop-sandbox` container wrapped in
 * the full network sandbox session (`toNetworkSandboxSession`). No
 * explicit `portEndpoint`: the adapter resolves the bridge through
 * `getPortEndpoint`, which joins the private sweatshop-harness network.
 * Not part of the normal gate:
 *
 *   CLAUDE_SPIKE=1 npx vitest run tests/claude-spike.integration.test.ts
 *
 * Proves: bridge bootstrap inside the sandbox, authenticated WS
 * handshake from this container, session create/destroy, and cleanup.
 * No model call by default; set CLAUDE_SPIKE_LIVE=1 (and
 * CLAUDE_CODE_OAUTH_TOKEN) to additionally run one bounded generate.
 */
const run = process.env.CLAUDE_SPIKE === "1" ? describe : describe.skip;

run("claude harness bridge spike (0006/0013)", () => {
  it(
    "bootstraps the claude bridge and completes the WS handshake",
    async () => {
      process.env.SWEATSHOP_DB = "data/sweatshop.db";
      const { createContainer, removeContainer } = await import(
        "../lib/sandboxes/provision"
      );
      const { podmanProvider } = await import("../lib/sandboxes/provider");
      const { toNetworkSandboxSession } = await import(
        "../lib/sandboxes/ai-sdk-adapter"
      );
      const { harnessBridgePort } = await import("../lib/sandboxes/harness-bridge");

      const name = `sweatshop-claude-spike-${Date.now()}`;
      const workDir = "/work/claude-spike";
      await createContainer(name);
      const sb = podmanProvider.attach(name, workDir);
      await sb.run(`mkdir -p ${workDir}/scratch`, undefined, "/");

      try {
        const sandboxSession = toNetworkSandboxSession({
          id: name,
          handle: sb,
          workDir,
        });
        const endpoint = await sandboxSession.getPortEndpoint({
          port: harnessBridgePort("claude"),
          protocol: "ws",
        });
        console.log("SPIKE endpoint:", endpoint.url);
        expect(endpoint.url).toMatch(/^ws:\/\/\d+\.\d+\.\d+\.\d+:4000$/);

        // 0021: the production builder, on a route — subscription auth
        // (setup-token through the env channel, direct), the route
        // contributing only model + effort (CLAUDE_SPIKE_MODEL, default sonnet).
        const { buildHarnessAgent } = await import("../workflows/chat/harness-agent");
        const agent = buildHarnessAgent({
          route: { harness: "claude", model: process.env.CLAUDE_SPIKE_MODEL ?? "sonnet", effort: "low" },
          sessionId: "spike-claude",
          tools: {},
        });

        if (process.env.CLAUDE_SPIKE_LIVE === "1") {
          expect(
            process.env.CLAUDE_CODE_OAUTH_TOKEN,
            "CLAUDE_SPIKE_LIVE requires CLAUDE_CODE_OAUTH_TOKEN",
          ).toBeTruthy();
          // The production grain: bridge bootstrap + WS handshake happen on
          // the first step; one semantic step per call, driven to the end.
          const end = await driveHarnessTurn({
            agent,
            sandboxSession,
            sessionId: "spike-claude",
            prompt:
              `Create the file ${workDir}/scratch/claude-spike.txt containing ` +
              "'claude bridge verified'. Do not commit or push.",
          });
          console.log("CLAUDE END:", JSON.stringify(end));
          expect(end.status).not.toBe("failed");
          const check = await sb.run(`cat ${workDir}/scratch/claude-spike.txt`);
          expect(check.stdout).toContain("claude bridge verified");
        } else {
          // No model call: bootstrap the bridge + WS handshake only (0006 go/no-go).
          const session = await agent.createSession({ sandboxSession });
          console.log("BRIDGE SESSION CREATED — bootstrap + WS handshake ok");
          expect(session).toBeTruthy();
          await session.destroy();
        }
      } finally {
        await removeContainer(name);
      }
    },
    600_000,
  );
});
