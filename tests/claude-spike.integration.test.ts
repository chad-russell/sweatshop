import { describe, expect, it } from "vitest";

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
      const { attachSandbox, createContainer, removeContainer } = await import(
        "../lib/sandboxes/provision"
      );
      const { toNetworkSandboxSession } = await import(
        "../lib/sandboxes/ai-sdk-adapter"
      );
      const { HARNESS_BRIDGE_PORT } = await import("../lib/sandboxes/harness-bridge");
      const { HarnessAgent } = await import("@ai-sdk/harness/agent");
      const { createClaudeCode } = await import("@ai-sdk/harness-claude-code");

      const name = `sweatshop-claude-spike-${Date.now()}`;
      const workDir = "/work/claude-spike";
      await createContainer(name);
      const sb = attachSandbox(name, workDir);
      await sb.run(`mkdir -p ${workDir}/scratch`, undefined, "/");

      try {
        const sandboxSession = toNetworkSandboxSession({
          id: name,
          handle: { ref: name, run: sb.run, spawn: sb.spawn },
          workDir,
        });
        const endpoint = await sandboxSession.getPortEndpoint({
          port: HARNESS_BRIDGE_PORT,
          protocol: "ws",
        });
        console.log("SPIKE endpoint:", endpoint.url);
        expect(endpoint.url).toMatch(/^ws:\/\/\d+\.\d+\.\d+\.\d+:4000$/);

        const harness = createClaudeCode({
          // 0006 amendment: setup-token rides the env channel, auth
          // route pinned to direct (no gateway, no host discovery).
          auth: "direct",
          port: HARNESS_BRIDGE_PORT,
          env: {
            CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
          },
        });
        const agent = new HarnessAgent({
          harness,
          id: "spike-claude",
          sandboxConfig: { workDir: "." },
        });

        // createSession bootstraps the bridge in-sandbox and completes
        // the authenticated WS handshake — the 0006 go/no-go.
        const session = await agent.createSession({ sandboxSession });
        console.log("BRIDGE SESSION CREATED — bootstrap + WS handshake ok");
        expect(session).toBeTruthy();

        if (process.env.CLAUDE_SPIKE_LIVE === "1") {
          expect(
            process.env.CLAUDE_CODE_OAUTH_TOKEN,
            "CLAUDE_SPIKE_LIVE requires CLAUDE_CODE_OAUTH_TOKEN",
          ).toBeTruthy();
          const result = await agent.generate({
            session,
            prompt:
              `Create the file ${workDir}/scratch/claude-spike.txt containing ` +
              "'claude bridge verified'. Do not commit or push.",
          });
          console.log("CLAUDE RESULT:", result.text.slice(0, 300));
          const check = await sb.run(`cat ${workDir}/scratch/claude-spike.txt`);
          expect(check.stdout).toContain("claude bridge verified");
        }

        await session.destroy();
        console.log("BRIDGE SESSION DESTROYED — cleanup ok");
      } finally {
        await removeContainer(name);
      }
    },
    600_000,
  );
});
