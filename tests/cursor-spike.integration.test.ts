import { describe, expect, it } from "vitest";
import { driveHarnessTurn } from "./helpers/drive-harness";

/**
 * 0038 cursor spike — @ai-sdk/harness-cursor on the real 0013 path, with a
 * browser-login credential (`agent login` → auth.json) instead of an API key.
 * Not part of the normal gate, and the adapter is NOT a repo dependency yet
 * (install it with `npm install --no-save` in a scratch node_modules):
 *
 *   CURSOR_SPIKE=1 CURSOR_SPIKE_IMAGE=localhost/sweatshop-sandbox-cursor-spike \
 *     npx vitest run tests/cursor-spike.integration.test.ts
 *
 * CURSOR_SPIKE_AUTH_JSON (default ~/.config/cursor/auth.json) is copied into
 * the sandbox's config dir for the CLI's private HOME. The sandbox needs curl
 * (the adapter's installer is `curl https://cursor.com/install | bash`).
 * CURSOR_SPIKE_LIVE=1 additionally runs one bounded generate.
 */
const run = process.env.CURSOR_SPIKE === "1" ? describe : describe.skip;

run("cursor harness spike (0038)", () => {
  it(
    "bootstraps the cursor ACP bridge with a browser-login credential",
    async () => {
      process.env.SWEATSHOP_DB = "data/sweatshop.db";
      const { readFile } = await import("node:fs/promises");
      const { homedir } = await import("node:os");
      const { createContainer, removeContainer } = await import("../lib/sandboxes/provision");
      const { podmanProvider } = await import("../lib/sandboxes/provider");
      const { toNetworkSandboxSession } = await import("../lib/sandboxes/ai-sdk-adapter");
      const { HARNESS_BRIDGE_PORT } = await import("../lib/sandboxes/harness-bridge");
      const { HarnessAgent } = await import("@ai-sdk/harness/agent");
      // Not a repo dependency yet (0038): a variable specifier keeps tsc and
      // vite from resolving it when the spike is skipped.
      const adapter = "@ai-sdk/harness-cursor";
      const { createCursor } = (await import(/* @vite-ignore */ adapter)) as {
        createCursor: (settings: { port: number }) => never;
      };
      const { isStepCount } = await import("ai");

      const authJson = await readFile(
        process.env.CURSOR_SPIKE_AUTH_JSON ?? `${homedir()}/.config/cursor/auth.json`,
        "utf8",
      );
      const name = `sweatshop-cursor-spike-${Date.now()}`;
      const workDir = "/work/cursor-spike";
      await createContainer(name, process.env.CURSOR_SPIKE_IMAGE);
      const sb = podmanProvider.attach(name, workDir);
      await sb.run(`mkdir -p ${workDir}/scratch`, undefined, "/");

      try {
        const sandboxSession = toNetworkSandboxSession({ id: name, handle: sb, workDir });
        const endpoint = await sandboxSession.getPortEndpoint({ port: HARNESS_BRIDGE_PORT, protocol: "ws" });
        console.log("SPIKE endpoint:", endpoint.url);

        // The CLI runs under the adapter's private HOME
        // (~/.ai-sdk-harness/<bridge>/implementation/home) — find it after
        // bootstrap rather than guessing; the spike plants auth.json there.
        const agent = new HarnessAgent({
          harness: createCursor({ port: HARNESS_BRIDGE_PORT }),
          id: "cursor-spike",
          sandboxConfig: { workDir: "." },
          tools: {},
          stopWhen: isStepCount(1),
        });

        const session = await agent.createSession({ sandboxSession });
        console.log("BRIDGE SESSION CREATED — install + bootstrap + WS handshake ok");
        const found = await sb.run(
          "find / -path '*/implementation/home/.local/bin/agent' 2>/dev/null | head -1",
          undefined,
          "/",
        );
        const agentBin = found.stdout.trim();
        console.log("agent binary:", agentBin || "NOT FOUND");
        expect(agentBin).toBeTruthy();
        const privateHome = agentBin.replace(/\/\.local\/bin\/agent$/, "");
        await session.destroy();

        // Plant the browser-login credential where the CLI reads it on linux:
        // $XDG_CONFIG_HOME or $HOME/.config → cursor/auth.json.
        const cfg = `${privateHome}/.config/cursor`;
        // CURSOR_SPIKE_NO_AUTH=1 is the negative control: same turn, no credential.
        const planted = process.env.CURSOR_SPIKE_NO_AUTH === "1" ? { exitCode: 0 } : await sb.run(
          `mkdir -p ${cfg} && printf %s "$AUTH_B64" | base64 -d > ${cfg}/auth.json && chmod 600 ${cfg}/auth.json`,
          { AUTH_B64: Buffer.from(authJson).toString("base64") },
          "/",
        );
        expect(planted.exitCode).toBe(0);
        const status = await sb.run(`HOME=${privateHome} ${agentBin} status 2>&1 | head -3`, undefined, "/");
        console.log("agent status in sandbox:", status.stdout.trim());

        if (process.env.CURSOR_SPIKE_LIVE === "1") {
          const live = new HarnessAgent({
            harness: createCursor({ port: HARNESS_BRIDGE_PORT }),
            id: "cursor-spike-live",
            sandboxConfig: { workDir: "." },
            tools: {},
            stopWhen: isStepCount(1),
          });
          const end = await driveHarnessTurn({
            agent: live,
            sandboxSession,
            sessionId: "spike-cursor",
            prompt:
              `Create the file ${workDir}/scratch/cursor-spike.txt containing ` +
              "'cursor bridge verified'. Do not commit or push.",
          });
          console.log("CURSOR END:", JSON.stringify(end));
          const after = await sb.run(`md5sum ${cfg}/auth.json 2>&1 | cut -c1-8; ls -la ${cfg} 2>&1 | tail -3`, undefined, "/");
          console.log("auth.json after turn:", after.stdout.trim());
          expect(end.status).not.toBe("failed");
          const check = await sb.run(`cat ${workDir}/scratch/cursor-spike.txt`);
          expect(check.stdout).toContain("cursor bridge verified");
        }
      } finally {
        await removeContainer(name);
      }
    },
    900_000,
  );
});
