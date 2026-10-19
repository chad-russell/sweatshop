import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { buildHarnessAgent } from "../workflows/chat/harness-agent";
import { saveCodexCredential } from "../lib/harness-auth/codex";

/**
 * 0050 phase 3: the codex builder branch, mocked off the network —
 * construction is pure (createCodex is a factory; the bridge only starts
 * on the first stream), so what is testable here is the credential gate
 * (fresh per call, fails fast with the way out) and that a login builds
 * a real agent. The live path is CODEX_SPIKE (phase 6).
 */

const fakeCodexAuthJson = (expMs: number) => {
  const jwt = (exp: number) =>
    ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(exp / 1000) })).toString("base64url"), "sig"].join(".");
  return JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: jwt(expMs), refresh_token: "r" } });
};

let dir: string;
let prevAuthDir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agent-"));
  prevAuthDir = process.env.HARNESS_AUTH_DIR;
  process.env.HARNESS_AUTH_DIR = dir;
});

afterEach(() => {
  if (prevAuthDir === undefined) delete process.env.HARNESS_AUTH_DIR;
  else process.env.HARNESS_AUTH_DIR = prevAuthDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("0050: buildHarnessAgent codex branch", () => {
  it("fails fast when codex is not logged in — the credential's own message", () => {
    expect(() =>
      buildHarnessAgent({ route: { harness: "codex" }, sessionId: "c_x", tools: {} }),
    ).toThrowError(/codex is not logged in/);
  });

  it("builds an agent (id, model optional) once a login exists — no network at construction", () => {
    saveCodexCredential(fakeCodexAuthJson(Date.now() + 30 * 86_400_000));
    const agent = buildHarnessAgent({
      route: { harness: "codex" },
      sessionId: "c_x",
      tools: {},
    });
    expect(agent).toBeInstanceOf(HarnessAgent);
    const withModel = buildHarnessAgent({
      route: { harness: "codex", model: "gpt-5.6-sol", effort: "high" },
      sessionId: "c_x",
      tools: {},
    });
    expect(withModel).toBeInstanceOf(HarnessAgent);
  });

  it("rejects an expired login the same way (a 401-stale file never reaches the bridge)", () => {
    saveCodexCredential(fakeCodexAuthJson(Date.now() - 1_000));
    expect(() =>
      buildHarnessAgent({ route: { harness: "codex" }, sessionId: "c_x", tools: {} }),
    ).toThrowError(/codex is not logged in/);
  });

  // 0050 review: auto-auth shadows the subscription if ANY api-key env
  // var is set (adapter resolveCodexEnv: gateway AI_GATEWAY_API_KEY /
  // VERCEL_OIDC_TOKEN first, then OPENAI_API_KEY ?? CODEX_API_KEY) —
  // the guard fails fast, naming the offender(s).
  it("fails fast naming any api-key env var that would shadow the subscription", () => {
    saveCodexCredential(fakeCodexAuthJson(Date.now() + 30 * 86_400_000));
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-shadow";
    try {
      expect(() => buildHarnessAgent({ route: { harness: "codex", model: "gpt-5.6-sol" }, sessionId: "c_x", tools: {} }))
        .toThrowError(/OPENAI_API_KEY is set — codex runs on the ChatGPT login; unset it/);
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
    // All clear → it builds (no lingering guard state).
    expect(
      buildHarnessAgent({ route: { harness: "codex", model: "gpt-5.6-sol" }, sessionId: "c_x", tools: {} }),
    ).toBeInstanceOf(HarnessAgent);
  });
});
