import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearCodexCredential,
  codexAuthPath,
  codexConfigured,
  codexCredential,
  codexCredentialSavedAt,
  codexHomeSplitWarning,
  CODEX_EXPIRY_MARGIN_MS,
  parseCodexAuth,
  resolveCodexHome,
  saveCodexCredential,
} from "../lib/harness-auth/codex";

/**
 * 0050: the Codex credential seam — parse/judge, store (0600, atomic),
 * and the CODEX_HOME pointer. No planting tests: codex auth is
 * env-carried (the adapter reads CODEX_HOME/auth.json in the app
 * process and forwards CODEX_API_KEY), so nothing ever enters a sandbox.
 */

const jwt = (expMs: number | null) =>
  [
    "e30",
    Buffer.from(JSON.stringify(expMs === null ? {} : { exp: Math.floor(expMs / 1000) })).toString("base64url"),
    "sig",
  ].join(".");
const authJson = (expMs: number | null, accountId?: string) =>
  JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: jwt(expMs),
      refresh_token: "refresh-token",
      ...(accountId === undefined ? {} : { account_id: accountId }),
    },
    last_refresh: new Date(0).toISOString(),
  });

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

describe("parseCodexAuth", () => {
  it("accepts a live login with an account id, preserving the exact text", () => {
    const text = authJson(NOW + 30 * DAY, "acct_enterprise");
    expect(parseCodexAuth(text, NOW)).toEqual({
      ok: true,
      json: text,
      expiresAt: Math.floor((NOW + 30 * DAY) / 1000) * 1000,
      accountId: "acct_enterprise",
    });
  });

  it("accepts a live login without an account id (accountId null)", () => {
    const r = parseCodexAuth(authJson(NOW + 30 * DAY), NOW);
    expect(r).toMatchObject({ ok: true, accountId: null });
  });

  it("refuses an expired login and one inside the (10 min, 0050 review) safety margin, naming the fix", () => {
    for (const exp of [NOW - DAY, NOW + CODEX_EXPIRY_MARGIN_MS - 60_000]) {
      const r = parseCodexAuth(authJson(exp, "acct"), NOW);
      expect(r).toMatchObject({ ok: false, reason: "expired" });
      if (!r.ok) {
        expect(r.message).toContain("start-a-turn safety margin");
        expect(r.message).toContain("/settings");
      }
    }
    expect(parseCodexAuth(authJson(NOW + CODEX_EXPIRY_MARGIN_MS + 60_000), NOW).ok).toBe(true);
    // NOT cursor's 1 h margin: a 30-minutes-left login is still usable —
    // the adapter refreshes inside the last 5 min once a session starts.
    expect(parseCodexAuth(authJson(NOW + 30 * 60_000), NOW).ok).toBe(true);
  });

  it("accepts a token with no exp claim (expiry unknown, still usable)", () => {
    expect(parseCodexAuth(authJson(null), NOW)).toMatchObject({ ok: true, expiresAt: null });
  });

  it("refuses non-JSON, non-objects, and files that are not a chatgpt login", () => {
    const notJson = ["not json", "[]"];
    for (const text of notJson) {
      expect(parseCodexAuth(text, NOW)).toMatchObject({ ok: false, reason: "invalid" });
    }
    const wrongShape = [
      // apikey-mode files exist but are a different auth — subscription only.
      JSON.stringify({ OPENAI_API_KEY: "sk-x" }),
      JSON.stringify({ auth_mode: "apikey", tokens: { access_token: jwt(NOW + DAY), refresh_token: "r" } }),
      JSON.stringify({ tokens: { access_token: jwt(NOW + DAY), refresh_token: "r" } }),
      JSON.stringify({ auth_mode: "chatgpt" }),
      JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "", refresh_token: "r" } }),
      JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: jwt(NOW + DAY) } }),
      // account_id is optional, but when present it must be a non-empty string.
      JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: jwt(NOW + DAY), refresh_token: "r", account_id: "" } }),
    ];
    for (const text of wrongShape) {
      const r = parseCodexAuth(text, NOW);
      expect(r).toMatchObject({ ok: false, reason: "invalid" });
      if (!r.ok) expect(r.message).toContain("chatgpt");
    }
  });

  it("never echoes a token in an error message", () => {
    const secret = "SECRET-TOKEN-VALUE";
    const r = parseCodexAuth(
      // Valid shape except the missing refresh token — the only echo risk
      // is the error path (an ok result carries the exact text by contract).
      JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: secret } }),
      NOW,
    );
    expect(r).toMatchObject({ ok: false, reason: "invalid" });
    expect(JSON.stringify(r)).not.toContain(secret);
  });
});

describe("stored credential", () => {
  let dir: string;
  let prev: string | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-"));
    prev = process.env.HARNESS_AUTH_DIR;
    process.env.HARNESS_AUTH_DIR = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.HARNESS_AUTH_DIR;
    else process.env.HARNESS_AUTH_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is missing until saved, and says where to put it", () => {
    expect(codexConfigured()).toBe(false);
    const r = codexCredential();
    expect(r).toMatchObject({ ok: false, reason: "missing" });
    if (!r.ok) expect(r.message).toContain(codexAuthPath());
  });

  it("saves 0600 under HARNESS_AUTH_DIR, reads back byte-identical, leaves no temp file", () => {
    const text = authJson(Date.now() + 30 * DAY, "acct_enterprise");
    expect(codexCredentialSavedAt()).toBeNull();
    expect(saveCodexCredential(text).ok).toBe(true);
    expect(codexAuthPath()).toBe(path.join(dir, "codex", "auth.json"));
    expect(fs.statSync(codexAuthPath()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(codexAuthPath())).mode & 0o777).toBe(0o700);
    const r = codexCredential();
    expect(r).toMatchObject({ ok: true, json: text, accountId: "acct_enterprise" });
    expect(fs.readdirSync(path.dirname(codexAuthPath()))).toEqual(["auth.json"]);
    expect(codexConfigured()).toBe(true);
    expect(typeof codexCredentialSavedAt()).toBe("number");
  });

  it("refuses to store a bad file (and keeps the previous good one)", () => {
    const good = authJson(Date.now() + 30 * DAY);
    saveCodexCredential(good);
    expect(saveCodexCredential("garbage")).toMatchObject({ ok: false, reason: "invalid" });
    expect(saveCodexCredential(authJson(Date.now() - DAY))).toMatchObject({ ok: false, reason: "expired" });
    expect(fs.readFileSync(codexAuthPath(), "utf8")).toBe(good);
  });

  it("an expired stored file reads as not configured", () => {
    fs.mkdirSync(path.dirname(codexAuthPath()), { recursive: true });
    fs.writeFileSync(codexAuthPath(), authJson(Date.now() - DAY));
    expect(codexConfigured()).toBe(false);
    expect(codexCredential()).toMatchObject({ ok: false, reason: "expired" });
  });

  it("clear removes it", () => {
    saveCodexCredential(authJson(Date.now() + 30 * DAY));
    clearCodexCredential();
    expect(codexConfigured()).toBe(false);
    clearCodexCredential(); // idempotent
  });
});

describe("resolveCodexHome", () => {
  let dir: string;
  let prev: string | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    prev = process.env.HARNESS_AUTH_DIR;
    process.env.HARNESS_AUTH_DIR = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.HARNESS_AUTH_DIR;
    else process.env.HARNESS_AUTH_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("points at the auth dir when CODEX_HOME is unset, honoring HARNESS_AUTH_DIR", () => {
    expect(resolveCodexHome({})).toBe(path.join(dir, "codex"));
    expect(resolveCodexHome({})).toBe(path.dirname(codexAuthPath()));
  });

  it("respects an operator override", () => {
    expect(resolveCodexHome({ CODEX_HOME: "/srv/codex" })).toBe("/srv/codex");
  });

  // 0050 review: an override that diverges while our own login exists
  // splits the login (UI writes ours, adapter reads the override) —
  // the helper feeds instrumentation's boot warning.
  it("codexHomeSplitWarning flags a diverging override only when our own login exists", () => {
    const ours = codexAuthPath();
    expect(codexHomeSplitWarning({}, () => true)).toBeNull();
    expect(codexHomeSplitWarning({ CODEX_HOME: path.dirname(ours) }, () => true)).toBeNull();
    expect(codexHomeSplitWarning({ CODEX_HOME: "/srv/codex" }, () => false)).toBeNull();
    const warned = codexHomeSplitWarning({ CODEX_HOME: "/srv/codex" }, (p) => p === ours);
    expect(warned).toContain("CODEX_HOME is overridden (/srv/codex)");
    expect(warned).toContain(ours);
  });
});
