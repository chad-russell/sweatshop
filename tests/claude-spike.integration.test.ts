import { spawn as nodeSpawn } from "node:child_process";
import { execFile } from "node:child_process";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);

/**
 * 0006 bridge feasibility spike — Claude Code harness adapter against a
 * disposable sandbox on the eve image (what session sandboxes actually
 * run), joined to the private sweatshop-harness network exactly like
 * the real path. Not part of the normal gate:
 *
 *   CLAUDE_SPIKE=1 npx vitest run tests/claude-spike.integration.test.ts
 *
 * Proves: bridge bootstrap inside the sandbox (node/pnpm present in the
 * eve image), authenticated WS handshake from this container, session
 * create/destroy, and cleanup. No model call — auth stays gated on a
 * Console API key; set CLAUDE_SPIKE_LIVE=1 AND ANTHROPIC_API_KEY to
 * additionally run one bounded generate.
 */
const run = process.env.CLAUDE_SPIKE === "1" ? describe : describe.skip;

/** docker exec-based spawn with real streams (bridge needs long-lived). */
function dockerSpawn(container: string) {
  return async (options: {
    command: string;
    env?: Record<string, string>;
    abortSignal?: AbortSignal;
  }) => {
    const args = ["exec", "-i", "-w", "/workspace"];
    for (const [k, v] of Object.entries(options.env ?? {})) {
      args.push("-e", `${k}=${v}`);
    }
    args.push(container, "bash", "-lc", options.command);
    const child = nodeSpawn("docker", args, { signal: options.abortSignal });
    return {
      stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
      wait: () =>
        new Promise<{ exitCode: number }>((resolve) => {
          child.on("exit", (code) => resolve({ exitCode: code ?? -1 }));
        }),
      kill: async () => {
        child.kill("SIGKILL");
      },
    };
  };
}

run("claude harness bridge spike (0006)", () => {
  it(
    "bootstraps the claude bridge and completes the WS handshake",
    async () => {
      process.env.SWEATSHOP_DB = "data/sweatshop.db";
      const { HARNESS_NETWORK, ensureHarnessNetwork } = await import(
        "../lib/sandboxes/harness-bridge"
      );
      const { toSandboxSession } = await import(
        "../lib/sandboxes/ai-sdk-adapter"
      );
      const { HarnessAgent } = await import("@ai-sdk/harness/agent");
      const { createClaudeCode } = await import("@ai-sdk/harness-claude-code");

      await ensureHarnessNetwork();

      // Disposable sandbox on the same image eve session sandboxes use.
      const name = `sweatshop-claude-spike-${Date.now()}`;
      await exec("docker", [
        "run",
        "-d",
        "--name",
        name,
        "ghcr.io/vercel/eve:0.67.2",
        "sleep",
        "2147483647",
      ]);
      const sb = {
        run: async (
          command: string,
          env?: Record<string, string>,
          workingDirectory?: string,
        ) => {
          // Env MUST ride as docker exec -e flags and recipe commands
          // carry a workingDirectory (bootstrap runs in its own dir).
          const args = ["exec"];
          if (workingDirectory) args.push("-w", workingDirectory);
          for (const [k, v] of Object.entries(env ?? {})) {
            args.push("-e", `${k}=${v}`);
          }
          args.push(name, "bash", "-lc", command);
          try {
            const { stdout, stderr } = await exec("docker", args);
            return { exitCode: 0, stdout, stderr };
          } catch (err) {
            const e = err as { code?: number; stdout?: string; stderr?: string };
            return {
              exitCode: e.code ?? 1,
              stdout: e.stdout ?? "",
              stderr: e.stderr ?? "",
            };
          }
        },
        remove: () => exec("docker", ["rm", "-f", name]).catch(() => undefined),
      };
      await sb.run("mkdir -p /workspace/scratch");

      try {
        // Join the private network; resolve the sandbox endpoint there.
        await exec("docker", ["network", "connect", HARNESS_NETWORK, name]);
        const { stdout: ipOut } = await exec("docker", [
          "inspect",
          "-f",
          `{{(index .NetworkSettings.Networks "${HARNESS_NETWORK}").IPAddress}}`,
          name,
        ]);
        const ip = ipOut.trim();
        console.log("SPIKE endpoint:", `ws://${ip}:4000`);
        expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

        const sandboxSession = toSandboxSession({
          run: sb.run,
          spawn: dockerSpawn(name),
        });

        const harness = createClaudeCode({
          auth: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "" },
          port: 4000,
          portEndpoint: { url: `ws://${ip}:4000` },
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
            process.env.ANTHROPIC_API_KEY,
            "CLAUDE_SPIKE_LIVE requires ANTHROPIC_API_KEY",
          ).toBeTruthy();
          const result = await agent.generate({
            session,
            prompt:
              "In /workspace/scratch: create claude-spike.txt containing " +
              "'claude bridge verified'. Do not commit or push.",
          });
          console.log("CLAUDE RESULT:", result.text.slice(0, 300));
          const check = await sb.run("cat /workspace/scratch/claude-spike.txt");
          expect(check.stdout).toContain("claude bridge verified");
        }

        await session.destroy();
        console.log("BRIDGE SESSION DESTROYED — cleanup ok");
      } finally {
        await sb.remove();
      }
    },
    600_000,
  );
});
