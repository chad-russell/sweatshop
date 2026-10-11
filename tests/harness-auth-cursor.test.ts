import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearCursorCredential,
  cursorAuthPath,
  cursorConfigured,
  cursorCredential,
  CURSOR_PRIVATE_HOME_SUFFIX,
  EXPIRY_MARGIN_MS,
  parseCursorAuth,
  plantCursorCredential,
  saveCursorCredential,
} from "../lib/harness-auth/cursor";

const exec = promisify(execFile);

/**
 * 0038: the Cursor credential seam — parse/judge, store (0600, atomic),
 * and plant into a sandbox. The plant test runs the real command in real
 * bash with a throwaway $HOME, so the quoting, the env-var transport and
 * the file mode are exercised, not asserted as strings.
 */

const jwt = (expMs: number | null) =>
  [
    "e30",
    Buffer.from(JSON.stringify(expMs === null ? {} : { exp: Math.floor(expMs / 1000) })).toString("base64url"),
    "sig",
  ].join(".");
const authJson = (expMs: number | null) => JSON.stringify({ accessToken: jwt(expMs), refreshToken: jwt(expMs) });

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

describe("parseCursorAuth", () => {
  it("accepts a live login and reports its expiry", () => {
    const text = authJson(NOW + 30 * DAY);
    expect(parseCursorAuth(text, NOW)).toEqual({ ok: true, json: text, expiresAt: Math.floor((NOW + 30 * DAY) / 1000) * 1000 });
  });

  it("accepts a token with no exp claim (expiry unknown)", () => {
    const r = parseCursorAuth(authJson(null), NOW);
    expect(r).toMatchObject({ ok: true, expiresAt: null });
  });

  it("refuses an expired login and one inside the safety margin, naming the fix", () => {
    for (const exp of [NOW - DAY, NOW + EXPIRY_MARGIN_MS - 60_000]) {
      const r = parseCursorAuth(authJson(exp), NOW);
      expect(r).toMatchObject({ ok: false, reason: "expired" });
      if (!r.ok) expect(r.message).toContain("agent login");
    }
    expect(parseCursorAuth(authJson(NOW + EXPIRY_MARGIN_MS + 60_000), NOW).ok).toBe(true);
  });

  it("refuses non-JSON and files missing either token", () => {
    expect(parseCursorAuth("not json", NOW)).toMatchObject({ ok: false, reason: "invalid" });
    expect(parseCursorAuth("[]", NOW)).toMatchObject({ ok: false, reason: "invalid" });
    expect(parseCursorAuth(JSON.stringify({ accessToken: "a" }), NOW)).toMatchObject({ ok: false, reason: "invalid" });
    expect(parseCursorAuth(JSON.stringify({ accessToken: "", refreshToken: "r" }), NOW)).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("never echoes a token in an error message", () => {
    const secret = "SECRET-TOKEN-VALUE";
    const r = parseCursorAuth(JSON.stringify({ accessToken: secret }), NOW);
    expect(JSON.stringify(r)).not.toContain(secret);
  });
});

describe("stored credential", () => {
  let dir: string;
  let prev: string | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-auth-"));
    prev = process.env.HARNESS_AUTH_DIR;
    process.env.HARNESS_AUTH_DIR = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.HARNESS_AUTH_DIR;
    else process.env.HARNESS_AUTH_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is missing until saved, and says where to put it", () => {
    expect(cursorConfigured()).toBe(false);
    const r = cursorCredential();
    expect(r).toMatchObject({ ok: false, reason: "missing" });
    if (!r.ok) expect(r.message).toContain(cursorAuthPath());
  });

  it("saves 0600 under HARNESS_AUTH_DIR, reads back byte-identical, leaves no temp file", () => {
    const text = authJson(Date.now() + 30 * DAY);
    expect(saveCursorCredential(text).ok).toBe(true);
    expect(cursorAuthPath()).toBe(path.join(dir, "cursor", "auth.json"));
    expect(fs.statSync(cursorAuthPath()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(cursorAuthPath())).mode & 0o777).toBe(0o700);
    const r = cursorCredential();
    expect(r).toMatchObject({ ok: true, json: text });
    expect(fs.readdirSync(path.dirname(cursorAuthPath()))).toEqual(["auth.json"]);
    expect(cursorConfigured()).toBe(true);
  });

  it("refuses to store a bad file (and keeps the previous good one)", () => {
    const good = authJson(Date.now() + 30 * DAY);
    saveCursorCredential(good);
    expect(saveCursorCredential("garbage")).toMatchObject({ ok: false, reason: "invalid" });
    expect(saveCursorCredential(authJson(Date.now() - DAY))).toMatchObject({ ok: false, reason: "expired" });
    expect(fs.readFileSync(cursorAuthPath(), "utf8")).toBe(good);
  });

  it("an expired stored file reads as not configured", () => {
    fs.mkdirSync(path.dirname(cursorAuthPath()), { recursive: true });
    fs.writeFileSync(cursorAuthPath(), authJson(Date.now() - DAY));
    expect(cursorConfigured()).toBe(false);
    expect(cursorCredential()).toMatchObject({ ok: false, reason: "expired" });
  });

  it("clear removes it", () => {
    saveCursorCredential(authJson(Date.now() + 30 * DAY));
    clearCursorCredential();
    expect(cursorConfigured()).toBe(false);
    clearCursorCredential(); // idempotent
  });
});

describe("plantCursorCredential", () => {
  /** Real bash, with $HOME pointing at a throwaway dir, like the sandbox shell. */
  function bashShell(home: string) {
    const commands: string[] = [];
    return {
      commands,
      shell: {
        async run(command: string, env?: Record<string, string>) {
          commands.push(command);
          try {
            const { stdout, stderr } = await exec("bash", ["-c", command], { env: { ...process.env, ...env, HOME: home } });
            return { exitCode: 0, stdout, stderr };
          } catch (err) {
            const e = err as { code?: number; stdout?: string; stderr?: string };
            return { exitCode: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
          }
        },
      },
    };
  }

  it("writes auth.json 0600 under the CLI's private HOME, exact bytes, credential never in the command", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "plant-home-"));
    try {
      const text = authJson(Date.now() + 30 * DAY);
      const { shell, commands } = bashShell(home);
      expect(await plantCursorCredential(shell, text)).toEqual({ ok: true });
      const target = path.join(home, CURSOR_PRIVATE_HOME_SUFFIX, ".config", "cursor", "auth.json");
      expect(fs.readFileSync(target, "utf8")).toBe(text);
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      // The credential rode in the env, never in argv/command text.
      const access = (JSON.parse(text) as { accessToken: string }).accessToken;
      for (const c of commands) {
        expect(c).not.toContain(access);
        expect(c).not.toContain(Buffer.from(text).toString("base64"));
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("re-planting overwrites a stale in-sandbox copy (host is the source of truth)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "plant-home-"));
    try {
      const { shell } = bashShell(home);
      await plantCursorCredential(shell, authJson(Date.now() + 10 * DAY));
      const fresh = authJson(Date.now() + 60 * DAY);
      await plantCursorCredential(shell, fresh);
      const target = path.join(home, CURSOR_PRIVATE_HOME_SUFFIX, ".config", "cursor", "auth.json");
      expect(fs.readFileSync(target, "utf8")).toBe(fresh);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports a failing plant value-shaped", async () => {
    const failing = { run: async () => ({ exitCode: 1, stdout: "", stderr: "read-only file system" }) };
    const r = await plantCursorCredential(failing, authJson(Date.now() + DAY));
    expect(r).toEqual({ ok: false, message: expect.stringContaining("read-only file system") });
  });
});
