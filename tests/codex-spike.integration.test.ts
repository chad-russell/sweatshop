import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CodexLoginHandle } from "../lib/harness-auth/codex-login";
import { driveHarnessTurn } from "./helpers/drive-harness";

/**
 * 0050 codex live check, opt-in — NEVER part of the gate. Three stages,
 * one env var, run on bee (podman + a real ChatGPT login):
 *
 *   CODEX_SPIKE=login_start npx vitest run tests/codex-spike.integration.test.ts
 *     → prints the device CODE/URL; relay them to Chad. Stage split
 *       exists because exec output only surfaces at completion — the
 *       code must be visible BEFORE anyone starts approving, and a
 *       single test cannot both show it and poll past it.
 *
 *   CODEX_SPIKE=login_poll   (within ~10 min of login_start)
 *     → polls the issuer to approval; the saved credential is then the
 *       one stage 3 runs on. Handle-file rule: spike-handle.json is
 *       0600 (it can be exchanged for tokens) and is DELETED on
 *       success — never left behind.
 *
 *   CODEX_SPIKE=turn CODEX_SPIKE=1  (either spelling) — the production
 *     turn through the route-driven buildHarnessAgent, a disposable
 *     sandbox on the network session. CODEX_SPIKE_NO_AUTH=1 is the
 *     negative control (empty CODEX_HOME — no credential means no
 *     finished turn). CODEX_SPIKE_IMAGE overrides the sandbox image
 *     (unset = localhost/sweatshop-sandbox; the codex CLI bootstrap
 *     needs pnpm, which the base image already bakes).
 */

const MODE = process.env.CODEX_SPIKE;
const spike = (want: string) => (MODE === want ? describe : describe.skip);
const turnRun = MODE === "turn" || MODE === "1" ? describe : describe.skip;

const HANDLE_PATH = path.join("data", "harness-auth", "codex", "spike-handle.json");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

spike("login_start")("codex login, stage 1: fetch a device code (0050)", () => {
  it("starts the device login and writes the exchange handle", async () => {
    const { startCodexDeviceLogin } = await import("../lib/harness-auth/codex-login");
    const result = await startCodexDeviceLogin();
    if (!result.ok) throw new Error(result.message);
    // The handle exchanges for tokens: 0600 now, deleted on stage-2 success.
    fs.mkdirSync(path.dirname(HANDLE_PATH), { recursive: true });
    fs.writeFileSync(HANDLE_PATH, JSON.stringify(result.handle), { mode: 0o600 });
    console.log(`CODE: ${result.userCode}`);
    console.log(`URL: ${result.verificationUrl}`);
    console.log(`interval: ${result.handle.interval}s, expires: ${new Date(result.handle.expiresAt).toLocaleString()}`);
  });
});

spike("login_poll")("codex login, stage 2: poll to approval (0050)", () => {
  it(
    "exchanges the handle for the saved credential",
    async () => {
      const { pollCodexDeviceLogin } = await import("../lib/harness-auth/codex-login");
      let handle: CodexLoginHandle = JSON.parse(fs.readFileSync(HANDLE_PATH, "utf8"));
      const started = Date.now();
      for (;;) {
        const result = await pollCodexDeviceLogin(handle);
        if (result.ok && result.status === "approved") {
          const { ok, expiresAt, accountId } = result.credential;
          expect(ok).toBe(true);
          fs.rmSync(HANDLE_PATH); // exchanged — never leave it behind
          const when = expiresAt === null ? "unknown" : new Date(expiresAt).toLocaleString();
          console.log(`LOGGED IN — expires ${when}, accountId ${accountId}`); // never tokens
          return;
        }
        if (result.ok && result.status === "pending") {
          if (Date.now() - started > 15 * 60 * 1000) {
            throw new Error("the login did not approve within 15 minutes");
          }
          handle = result.handle; // slow_down widens the interval here
          await sleep(handle.interval * 1000);
          continue;
        }
        throw new Error(result.message);
      }
    },
    600_000,
  );
});

turnRun("codex harness, production path (0050)", () => {
  it(
    "resolves the subscription from CODEX_HOME, bootstraps the bridge, and finishes a turn",
    async () => {
      process.env.SWEATSHOP_DB = "data/sweatshop.db";
      const { readFile, mkdtemp } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { createContainer, removeContainer } = await import("../lib/sandboxes/provision");
      const { podmanProvider } = await import("../lib/sandboxes/provider");
      const { toNetworkSandboxSession } = await import("../lib/sandboxes/ai-sdk-adapter");
      const { parseCodexAuth } = await import("../lib/harness-auth/codex");

      const authPath = process.env.CODEX_SPIKE_AUTH_JSON ?? path.join("data", "harness-auth", "codex", "auth.json");
      const credential = parseCodexAuth(await readFile(authPath, "utf8"));
      expect(credential.ok, credential.ok ? "" : credential.message).toBe(true);

      // Auto-detect precedence guard (0050): with `auth` unset the
      // adapter prefers gateway/direct env credentials over the
      // subscription — the app env must not carry these. Fail fast,
      // naming the offender.
      for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY", "AI_GATEWAY_API_KEY"]) {
        if (process.env[name]) {
          throw new Error(`${name} is set — unset it, or the adapter auto-detects it instead of the ChatGPT subscription`);
        }
      }

      // The adapter resolves the subscription from CODEX_HOME. In
      // production instrumentation-node sets it before anything imports
      // the builder; the spike must do the same for THIS vitest process
      // — so it is set BEFORE the builder (which pulls
      // @ai-sdk/harness-codex) is imported below. The negative control
      // points it at an empty temp dir: no auth.json, no subscription.
      const noAuth = process.env.CODEX_SPIKE_NO_AUTH === "1";
      process.env.CODEX_HOME = noAuth
        ? await mkdtemp(path.join(tmpdir(), "codex-spike-noauth-"))
        : path.dirname(path.resolve(authPath));

      const { buildHarnessAgent } = await import("../workflows/chat/harness-agent");

      const name = `sweatshop-codex-spike-${Date.now()}`;
      const workDir = "/work/codex-spike";
      await createContainer(name, process.env.CODEX_SPIKE_IMAGE);
      const sb = podmanProvider.attach(name, workDir);
      await sb.run(`mkdir -p ${workDir}/scratch`, undefined, "/");

      try {
        const sandboxSession = toNetworkSandboxSession({ id: name, handle: sb, workDir });
        const agent = buildHarnessAgent({
          route: {
            harness: "codex",
            ...(process.env.CODEX_SPIKE_MODEL ? { model: process.env.CODEX_SPIKE_MODEL } : {}),
          },
          sessionId: "spike-codex",
          tools: {},
        });

        const end = await driveHarnessTurn({
          agent,
          sandboxSession,
          sessionId: "spike-codex",
          prompt: `Create ${workDir}/scratch/hello.txt containing the single word ok, then reply done.`,
        });
        console.log("CODEX END:", JSON.stringify(end));

        if (noAuth) {
          // The point: no credential, no finished turn. Any failure
          // passes; auth/401/token in the text confirms the shape, and
          // the error is logged either way (be lenient — adapter
          // wording may differ).
          expect(end.status).toBe("failed");
          const text = JSON.stringify(end).toLowerCase();
          if (!/auth|401|token/.test(text)) {
            console.log("NO-AUTH FAILURE (unexpected shape):", text);
          }
          return;
        }
        expect(end.status).toBe("finished");
        const check = await sb.run(`cat ${workDir}/scratch/hello.txt`);
        expect(check.stdout).toContain("ok");
      } finally {
        await removeContainer(name);
      }
    },
    900_000,
  );
});
