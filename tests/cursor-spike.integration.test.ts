import { describe, expect, it } from "vitest";
import { driveHarnessTurn } from "./helpers/drive-harness";

/**
 * 0038 cursor live check, on the PRODUCTION path — the route-driven
 * `buildHarnessAgent`, the credential seam (`lib/harness-auth/cursor.ts`,
 * planted BEFORE the adapter's first bootstrap, exactly like
 * `harnessAdvanceStep`), a disposable sandbox wrapped in the full network
 * session, and the production turn grain (`driveHarnessTurn`). Not part of
 * the normal gate:
 *
 *   CURSOR_SPIKE=1 CURSOR_SPIKE_AUTH_JSON=~/.config/cursor/auth.json \
 *     npx vitest run tests/cursor-spike.integration.test.ts
 *
 * The sandbox image needs curl (Containerfile.sandbox; the adapter's
 * installer is `curl https://cursor.com/install | bash`) — set
 * CURSOR_SPIKE_IMAGE to an image that has it until the base image is
 * rebuilt. CURSOR_SPIKE_NO_AUTH=1 is the negative control (same turn,
 * nothing planted — must fail "Authentication required").
 */
const run = process.env.CURSOR_SPIKE === "1" ? describe : describe.skip;

run("cursor harness, production path (0038)", () => {
  it(
    "plants the credential, bootstraps the bridge, and finishes a turn",
    async () => {
      process.env.SWEATSHOP_DB = "data/sweatshop.db";
      const { readFile } = await import("node:fs/promises");
      const { homedir } = await import("node:os");
      const { createContainer, removeContainer } = await import("../lib/sandboxes/provision");
      const { podmanProvider } = await import("../lib/sandboxes/provider");
      const { toNetworkSandboxSession } = await import("../lib/sandboxes/ai-sdk-adapter");
      const { parseCursorAuth, plantCursorCredential } = await import("../lib/harness-auth/cursor");
      const { buildHarnessAgent } = await import("../workflows/chat/harness-agent");

      const authJson = await readFile(
        process.env.CURSOR_SPIKE_AUTH_JSON ?? `${homedir()}/.config/cursor/auth.json`,
        "utf8",
      );
      const credential = parseCursorAuth(authJson);
      expect(credential.ok, credential.ok ? "" : credential.message).toBe(true);

      const name = `sweatshop-cursor-spike-${Date.now()}`;
      const workDir = "/work/cursor-spike";
      await createContainer(name, process.env.CURSOR_SPIKE_IMAGE);
      const sb = podmanProvider.attach(name, workDir);
      await sb.run(`mkdir -p ${workDir}/scratch`, undefined, "/");

      try {
        const sandboxSession = toNetworkSandboxSession({ id: name, handle: sb, workDir });

        // Production order (harnessAdvanceStep): plant, THEN build + run.
        if (process.env.CURSOR_SPIKE_NO_AUTH !== "1" && credential.ok) {
          expect(await plantCursorCredential(sb, credential.json)).toEqual({ ok: true });
        }
        const agent = buildHarnessAgent({
          route: { harness: "cursor", ...(process.env.CURSOR_SPIKE_MODEL ? { model: process.env.CURSOR_SPIKE_MODEL } : {}) },
          sessionId: "spike-cursor",
          tools: {},
        });

        const end = await driveHarnessTurn({
          agent,
          sandboxSession,
          sessionId: "spike-cursor",
          prompt:
            `Create the file ${workDir}/scratch/cursor-spike.txt containing ` +
            "'cursor bridge verified'. Do not commit or push.",
        });
        console.log("CURSOR END:", JSON.stringify(end));

        if (process.env.CURSOR_SPIKE_NO_AUTH === "1") {
          expect(end.status).toBe("failed");
          return;
        }
        expect(end.status).not.toBe("failed");
        const check = await sb.run(`cat ${workDir}/scratch/cursor-spike.txt`);
        expect(check.stdout).toContain("cursor bridge verified");
      } finally {
        await removeContainer(name);
      }
    },
    900_000,
  );
});
