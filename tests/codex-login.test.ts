import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CODEX_LOGIN_CLIENT_ID,
  codexLoginIssuer,
  pollCodexDeviceLogin,
  startCodexDeviceLogin,
  type CodexLoginHandle,
} from "../lib/harness-auth/codex-login";
import { codexAuthPath, codexCredential, parseCodexAuth } from "../lib/harness-auth/codex";
import { DELETE as logoutRoute, POST as accountRoute } from "../app/api/x/codex/login/route";
import { POST as pollRoute } from "../app/api/x/codex/login/poll/route";

/**
 * 0050 phase 5: the codex device login against a fake issuer (injected
 * fetch — the endpoints are source-inferred from the codex CLI, so the
 * wire contract is pinned here; CODEX_SPIKE proves it live in phase 6).
 * Tokens never appear in any failure message — asserted, not assumed.
 */

const ISSUER = "http://issuer.test";
const ACCESS = "at_secret_token_value";

/** A router keyed by URL path, calling back with the request body. */
function fakeIssuer(routes: Record<string, (body: unknown) => { status: number; body: unknown }>) {
  const calls: { url: string; body: unknown }[] = [];
  const doFetch = (async (url: string, init?: RequestInit) => {
    const pathname = new URL(url).pathname;
    calls.push({ url: pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
    const route = routes[pathname];
    if (!route) return Response.json({ error: `no route for ${pathname}` }, { status: 404 });
    const { status, body } = route(calls.at(-1)!.body);
    return Response.json(body, { status });
  }) as typeof fetch;
  return { doFetch, calls };
}

const jwt = (payload: Record<string, unknown>) =>
  ["e30", Buffer.from(JSON.stringify(payload)).toString("base64url"), "sig"].join(".");

const enterpriseIdToken = jwt({ chatgpt_account_id: "org-9" });
const expSoon = Date.now() + 30 * 86_400_000;

const approvedTokenRoute = () => ({
  status: 200,
  body: { authorization_code: "ac_1", code_verifier: "vfy_1", code_challenge: "chal" },
});
const tokenExchangeRoute = (tokens: Record<string, string>) => ({ status: 200, body: tokens });

let dir: string;
let prevAuthDir: string | undefined;
let prevIssuer: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-login-"));
  prevAuthDir = process.env.HARNESS_AUTH_DIR;
  prevIssuer = process.env.CODEX_LOGIN_ISSUER;
  process.env.HARNESS_AUTH_DIR = dir;
  process.env.CODEX_LOGIN_ISSUER = ISSUER;
});

afterEach(() => {
  if (prevAuthDir === undefined) delete process.env.HARNESS_AUTH_DIR;
  else process.env.HARNESS_AUTH_DIR = prevAuthDir;
  if (prevIssuer === undefined) delete process.env.CODEX_LOGIN_ISSUER;
  else process.env.CODEX_LOGIN_ISSUER = prevIssuer;
  fs.rmSync(dir, { recursive: true, force: true });
});

const baseHandle: CodexLoginHandle = {
  deviceAuthId: "da_1",
  userCode: "WDJB-MJHT",
  interval: 5,
  expiresAt: Date.now() + 9 * 60 * 1000,
};

const userCodeRoute = () => ({ status: 200, body: { user_code: "WDJB-MJHT", device_auth_id: "da_1", interval: 5 } });

describe("0050: startCodexDeviceLogin", () => {
  it("asks the issuer for a code with the CLI's client id and returns what the UI needs", async () => {
    const issuer = fakeIssuer({ "/api/accounts/deviceauth/usercode": userCodeRoute });
    const result = await startCodexDeviceLogin({ fetch: issuer.doFetch });
    expect(result).toMatchObject({
      ok: true,
      userCode: "WDJB-MJHT",
      verificationUrl: `${ISSUER}/codex/device`,
      handle: { deviceAuthId: "da_1", interval: 5 },
    });
    if (!result.ok) return;
    expect(result.handle.expiresAt).toBeGreaterThan(Date.now() + 9 * 60 * 1000);
    expect(issuer.calls[0]).toEqual({
      url: "/api/accounts/deviceauth/usercode",
      body: { client_id: "app_EMoamEEZ73f0CkXaXp7hrann" },
    });
    expect(CODEX_LOGIN_CLIENT_ID).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(codexLoginIssuer()).toBe(ISSUER);
  });

  it("fails value-shaped when the issuer refuses the start", async () => {
    const issuer = fakeIssuer({
      "/api/accounts/deviceauth/usercode": () => ({ status: 403, body: { error: "unauthorized_client" } }),
    });
    const result = await startCodexDeviceLogin({ fetch: issuer.doFetch });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("HTTP 403");
  });
});

describe("0050: pollCodexDeviceLogin", () => {
  it("stays pending on authorization_pending, widens the interval on slow_down", async () => {
    const responses = [{ status: 400, body: { error: "authorization_pending" } }, { status: 400, body: { error: "slow_down" } }];
    const issuer = fakeIssuer({
      "/api/accounts/deviceauth/token": () => responses.shift()!,
    });
    const first = await pollCodexDeviceLogin(baseHandle, { fetch: issuer.doFetch });
    expect(first).toEqual({ ok: true, status: "pending", handle: baseHandle });
    const second = await pollCodexDeviceLogin(baseHandle, { fetch: issuer.doFetch });
    expect(second).toMatchObject({ ok: true, status: "pending" });
    if (second.ok && second.status === "pending") expect(second.handle.interval).toBe(8); // ceil(5 × 1.5)
  });

  it("approves: exact exchange body, CLI-shaped auth.json saved, enterprise account id", async () => {
    const issuer = fakeIssuer({
      "/api/accounts/deviceauth/token": approvedTokenRoute,
      "/oauth/token": () =>
        tokenExchangeRoute({
          access_token: jwt({ exp: Math.floor(expSoon / 1000) }),
          refresh_token: "rt_1",
          id_token: enterpriseIdToken,
        }),
    });
    const result = await pollCodexDeviceLogin(baseHandle, { fetch: issuer.doFetch });
    expect(result).toMatchObject({ ok: true, status: "approved" });
    expect(issuer.calls[1]).toEqual({
      url: "/oauth/token",
      body: {
        grant_type: "authorization_code",
        client_id: CODEX_LOGIN_CLIENT_ID,
        code: "ac_1",
        redirect_uri: `${ISSUER}/deviceauth/callback`,
        code_verifier: "vfy_1",
      },
    });
    const credential = codexCredential();
    expect(credential).toMatchObject({ ok: true, accountId: "org-9" });
    // The exact text saved — the CLI's own file shape, round-trips.
    const text = fs.readFileSync(codexAuthPath(), "utf8");
    expect(JSON.parse(text)).toEqual({
      auth_mode: "chatgpt",
      tokens: { access_token: jwt({ exp: Math.floor(expSoon / 1000) }), refresh_token: "rt_1", account_id: "org-9" },
      last_refresh: JSON.parse(text).last_refresh,
    });
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('  "auth_mode": "chatgpt"'); // 2-space pretty
    expect(parseCodexAuth(text).ok).toBe(true);
  });

  it("a personal login (no chatgpt_account_id claim) saves without an account id", async () => {
    const issuer = fakeIssuer({
      "/api/accounts/deviceauth/token": approvedTokenRoute,
      "/oauth/token": () =>
        tokenExchangeRoute({
          access_token: jwt({ exp: Math.floor(expSoon / 1000) }),
          refresh_token: "rt_1",
          id_token: jwt({ sub: "auth0|personal" }),
        }),
    });
    const result = await pollCodexDeviceLogin(baseHandle, { fetch: issuer.doFetch });
    expect(result).toMatchObject({ ok: true, status: "approved" });
    const credential = codexCredential();
    expect(credential).toMatchObject({ ok: true, accountId: null });
    expect(fs.readFileSync(codexAuthPath(), "utf8")).not.toContain("account_id");
  });

  it("an issuer hard-fail (expired_token) is value-shaped, names the issuer error, never a token", async () => {
    const issuer = fakeIssuer({
      "/api/accounts/deviceauth/token": () => ({ status: 400, body: { error: "expired_token" } }),
    });
    const result = await pollCodexDeviceLogin(baseHandle, { fetch: issuer.doFetch });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("expired_token");
      expect(result.message).not.toContain(ACCESS);
    }
  });

  it("an exchange failure reports the status, not the bodies", async () => {
    const issuer = fakeIssuer({
      "/api/accounts/deviceauth/token": approvedTokenRoute,
      "/oauth/token": () => ({ status: 400, body: { error: "invalid_grant", access_token: ACCESS } }),
    });
    const result = await pollCodexDeviceLogin(baseHandle, { fetch: issuer.doFetch });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("exchange failed");
      expect(result.message).not.toContain(ACCESS);
    }
  });

  it("gives up at the handle's expiry without calling the issuer", async () => {
    const issuer = fakeIssuer({ "/api/accounts/deviceauth/token": approvedTokenRoute });
    const result = await pollCodexDeviceLogin(
      { ...baseHandle, expiresAt: Date.now() - 1 },
      { fetch: issuer.doFetch },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("expired");
    expect(issuer.calls).toHaveLength(0);
  });
});

describe("0050: /api/x/codex/login routes", () => {
  const validAuthJson = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: jwt({ exp: Math.floor(expSoon / 1000) }), refresh_token: "rt_1" },
    last_refresh: new Date().toISOString(),
  });

  it("paste validates and saves (the headless fallback)", async () => {
    const res = await accountRoute(
      new Request("http://x/api/x/codex/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "paste", authJson: validAuthJson }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; credential: { configured: boolean; accountId: string | null } };
    expect(body.ok).toBe(true);
    expect(body.credential).toEqual({ configured: true, expiresAt: expect.any(Number), accountId: null });
    expect(codexCredential().ok).toBe(true);
  });

  it("paste rejects junk value-shaped", async () => {
    const res = await accountRoute(
      new Request("http://x/api/x/codex/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "paste", authJson: "not json" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("not valid JSON");
  });

  it("DELETE logs out", async () => {
    fs.mkdirSync(path.dirname(codexAuthPath()), { recursive: true });
    fs.writeFileSync(codexAuthPath(), validAuthJson, { mode: 0o600 });
    const res = await logoutRoute();
    expect(res.status).toBe(200);
    expect(codexCredential().ok).toBe(false);
  });

  it("poll requires a well-formed handle; an approval carries the status shape only — never tokens", async () => {
    const bad = await pollRoute(
      new Request("http://x/api/x/codex/login/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: { deviceAuthId: "da_1" } }),
      }),
    );
    expect(bad.status).toBe(400);

    // The route calls pollCodexDeviceLogin with the default fetch, so
    // route the REAL global through the fake issuer for this one call.
    const issuer = fakeIssuer({
      "/api/accounts/deviceauth/token": approvedTokenRoute,
      "/oauth/token": () =>
        tokenExchangeRoute({
          access_token: jwt({ exp: Math.floor(expSoon / 1000) }),
          refresh_token: "rt_1",
          id_token: enterpriseIdToken,
        }),
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = issuer.doFetch;
    try {
      const res = await pollRoute(
        new Request("http://x/api/x/codex/login/poll", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ handle: baseHandle }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; credential: Record<string, unknown> };
      expect(body.status).toBe("approved");
      expect(body.credential).toEqual({ configured: true, expiresAt: expect.any(Number), accountId: "org-9" });
      const text = JSON.stringify(body);
      expect(text).not.toContain("access_token");
      expect(text).not.toContain("refresh_token");
      expect(text).not.toContain('"json"');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
