import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import { gitCredentials } from "../db/schema";
import { saveCodexCredential } from "../lib/harness-auth/codex";
import { saveCursorCredential } from "../lib/harness-auth/cursor";
import { GLM_MODELS } from "../lib/providers/catalog";
import { __setGatewayForTests, __resetCachesForTests } from "../lib/skills/store";
import { buildConnectors, testConnector } from "../lib/settings/connectors";
import { FakeBucket, skillMd } from "./helpers/fake-bucket";

/**
 * 0090 §2: the connector model — rows from existing reads (value shapes,
 * never a secret echo) and the [Test] dispatch, with fetch stubbed so no
 * test touches a network.
 */

const ENV_KEYS = ["ZAI_API_KEY", "GLOO_API_KEY", "OPENROUTER_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;
const saved: Record<string, string | undefined> = {};
let dir: string;
let prevAuthDir: string | undefined;
let bucket: FakeBucket;
const realFetch = globalThis.fetch;
let calls: { url: string; init?: RequestInit }[] = [];

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.ZAI_API_KEY = "zai-secret-key";
  delete process.env.GLOO_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  for (const k of Object.keys(process.env)) if (k.startsWith("SKILLS_S3_")) delete process.env[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "connectors-"));
  prevAuthDir = process.env.HARNESS_AUTH_DIR;
  process.env.HARNESS_AUTH_DIR = dir;
  bucket = new FakeBucket();
  __setGatewayForTests(bucket);
  db().delete(gitCredentials).run();
  calls = [];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  if (prevAuthDir === undefined) delete process.env.HARNESS_AUTH_DIR;
  else process.env.HARNESS_AUTH_DIR = prevAuthDir;
  fs.rmSync(dir, { recursive: true, force: true });
  __setGatewayForTests(null);
  globalThis.fetch = realFetch;
});

/** Stub every outgoing fetch (resetting the capture); record URL + headers. */
function stubFetch(status: number) {
  calls = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response("[]", { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function row(rows: Awaited<ReturnType<typeof buildConnectors>>, id: string) {
  const found = rows.find((r) => r.id === id);
  if (!found) throw new Error(`no connector row ${id}`);
  return found;
}

function seedGithub(username = "chad") {
  db()
    .insert(gitCredentials)
    .values({ id: `gh-${username}`, kind: "github", label: username, username, secret: "tok", baseUrl: null, createdAt: 0 })
    .onConflictDoNothing()
    .run();
}

function seedForgejo(baseUrl: string, username = "chad") {
  db()
    .insert(gitCredentials)
    .values({ id: `fj-${baseUrl}`, kind: "forgejo", label: username, username, secret: "tok", baseUrl, createdAt: 0 })
    .onConflictDoNothing()
    .run();
}

const jwt = (exp: number) =>
  ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(exp / 1000) })).toString("base64url"), "sig"].join(".");
const CURSOR_AUTH = (expMs: number) => JSON.stringify({ accessToken: jwt(expMs), refreshToken: "r" });
const CODEX_AUTH = (expMs: number) =>
  JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: jwt(expMs), refresh_token: "r" } });

describe("buildConnectors (0090 §2)", () => {
  it("provider rows echo availability and model counts, never the key", async () => {
    const rows = await buildConnectors(db());
    expect(row(rows, "glm")).toMatchObject({ kind: "provider", label: "GLM (Z.AI)", statusText: `key set · ${GLM_MODELS.length} models`, ok: true });
    expect(row(rows, "gloo")).toMatchObject({ statusText: "key not set", ok: false, meta: "Set GLOO_API_KEY in ~/sweatshop/.env.local", copy: "GLOO_API_KEY=" });
    expect(row(rows, "openrouter")).toMatchObject({ statusText: "key not set", ok: false });
    for (const r of rows) expect(JSON.stringify(r)).not.toContain("zai-secret-key");
  });

  it("claude echoes the token env; cursor/codex read their saved logins", async () => {
    let rows = await buildConnectors(db());
    expect(row(rows, "claude")).toMatchObject({ statusText: "token not set", ok: false, copy: "CLAUDE_CODE_OAUTH_TOKEN=" });
    expect(row(rows, "cursor")).toMatchObject({ statusText: "not logged in", ok: false });
    expect(row(rows, "cursor").meta).toContain("agent login");

    process.env.CLAUDE_CODE_OAUTH_TOKEN = "t";
    saveCursorCredential(CURSOR_AUTH(Date.now() + 41.5 * 86_400_000));
    saveCodexCredential(CODEX_AUTH(Date.now() + 30 * 86_400_000));
    rows = await buildConnectors(db());
    expect(row(rows, "claude")).toMatchObject({ statusText: "token set", ok: true });
    expect(row(rows, "cursor")).toMatchObject({ statusText: "logged in · expires in 41 days", ok: true });
    expect(row(rows, "codex").statusText).toMatch(/logged in · expires in \d+ days/);
  });

  it("git rows are one per host; github.com stays as the empty state", async () => {
    let rows = await buildConnectors(db());
    expect(row(rows, "git:github.com")).toMatchObject({ statusText: "no credentials", ok: false });
    expect(row(rows, "git:github.com").meta).toContain("Add a credential below");

    seedGithub("chad");
    seedGithub("glen");
    seedForgejo("https://git.example.com", "chad");
    rows = await buildConnectors(db());
    expect(row(rows, "git:github.com")).toMatchObject({ statusText: "@chad · 2 credentials", ok: true });
    expect(row(rows, "git:https://git.example.com")).toMatchObject({ statusText: "@chad · 1 credential", ok: true });
  });

  it("the skills row follows the store status, error included", async () => {
    bucket.seed("pdf", skillMd("Make PDFs"));
    let rows = await buildConnectors(db());
    expect(row(rows, "skills")).toMatchObject({ statusText: "connected · 1 skill", ok: true });

    bucket.failList = new Error("fetch boom");
    __resetCachesForTests();
    rows = await buildConnectors(db());
    expect(row(rows, "skills")).toMatchObject({ statusText: "error: fetch boom", ok: false });

    __setGatewayForTests(null);
    rows = await buildConnectors(db());
    expect(row(rows, "skills")).toMatchObject({ statusText: "not configured", ok: false });
    expect(row(rows, "skills").meta).toContain("SKILLS_S3_*");
  });
});

describe("testConnector (0090 §2)", () => {
  it("glm/gloo without a key refuse without a request", async () => {
    delete process.env.ZAI_API_KEY;
    expect(await testConnector(db(), "glm")).toEqual({ ok: false, detail: "no key set" });
    expect(calls).toEqual([]);
  });

  it("a key set: one bearer models-list request; 200 ok, 401 not", async () => {
    stubFetch(200);
    expect(await testConnector(db(), "glm")).toEqual({ ok: true, detail: "reachable (HTTP 200)" });
    expect(calls[0]).toMatchObject({ url: "https://api.z.ai/api/coding/paas/v4/models" });
    expect((calls[0].init?.headers ?? {}) as Record<string, string>).toMatchObject({
      authorization: "Bearer zai-secret-key",
    });

    process.env.GLOO_API_KEY = "gloo-key";
    stubFetch(401);
    expect(await testConnector(db(), "gloo")).toEqual({ ok: false, detail: "HTTP 401 from gloo" });
    expect(calls[0].url).toBe("https://platform.ai.gloo.com/ai/v2/models");
  });

  it("openrouter's list is public — reachable without a key, noted in the detail", async () => {
    stubFetch(200);
    expect(await testConnector(db(), "openrouter")).toEqual({ ok: true, detail: "reachable (HTTP 200) · no key set" });
    expect(calls[0].init?.headers).toBeUndefined();

    process.env.OPENROUTER_API_KEY = "or-key";
    expect(await testConnector(db(), "openrouter")).toEqual({ ok: true, detail: "reachable (HTTP 200)" });
  });

  it("a failing fetch is a value, not a throw", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    await expect(testConnector(db(), "glm")).resolves.toEqual({ ok: false, detail: "network down" });
  });

  it("claude echoes token presence — no live check this phase", async () => {
    expect(await testConnector(db(), "claude")).toEqual({ ok: false, detail: "token not set" });
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "t";
    expect(await testConnector(db(), "claude")).toEqual({ ok: true, detail: "token present (live check not supported yet)" });
  });

  it("cursor/codex test the saved credential locally", async () => {
    let res = await testConnector(db(), "cursor");
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("not logged in");
    saveCursorCredential(CURSOR_AUTH(Date.now() + 20 * 86_400_000));
    res = await testConnector(db(), "cursor");
    expect(res).toMatchObject({ ok: true });
    expect(res.detail).toMatch(/logged in · expires in \d+ days/);
  });

  it("git host tests count stored credentials (honest echo, no host call)", async () => {
    seedGithub();
    seedGithub("glen");
    expect(await testConnector(db(), "git:github.com")).toEqual({
      ok: true,
      detail: "2 credentials stored (live host check not supported)",
    });
    expect(await testConnector(db(), "git:nowhere.example")).toEqual({ ok: false, detail: "no credentials stored" });
    expect(calls).toEqual([]);
  });

  it("skills tests through the live store gateway", async () => {
    expect(await testConnector(db(), "skills")).toEqual({ ok: true, detail: "connected" });
    bucket.failList = new Error("fetch boom");
    expect(await testConnector(db(), "skills")).toEqual({ ok: false, detail: "fetch boom" });
  });

  it("unknown connectors are a value, not an error", async () => {
    expect(await testConnector(db(), "bogus")).toEqual({ ok: false, detail: "unknown connector" });
  });
});
