import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { projects } from "../db/schema";
import { modelsView } from "../lib/providers/catalog-view";
import { saveCodexCredential } from "../lib/harness-auth/codex";

/**
 * 0050 phase 4: the codex entry of the models view (what /settings and
 * the project Models card read) — status-only until the login flow
 * (phase 5), but the view already reports everything the row shows:
 * configured/status, expiry, the enterprise account id, the offered
 * models, and the project allow-list flag.
 */

const fakeCodexAuthJson = (expMs: number, accountId?: string) => {
  const jwt = (exp: number) =>
    ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(exp / 1000) })).toString("base64url"), "sig"].join(".");
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: jwt(expMs), refresh_token: "r", ...(accountId ? { account_id: accountId } : {}) },
  });
};

let dir: string;
let prevAuthDir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-view-"));
  prevAuthDir = process.env.HARNESS_AUTH_DIR;
  process.env.HARNESS_AUTH_DIR = dir;
});

afterEach(() => {
  if (prevAuthDir === undefined) delete process.env.HARNESS_AUTH_DIR;
  else process.env.HARNESS_AUTH_DIR = prevAuthDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("0050: modelsView codex entry", () => {
  it("reports not-logged-in (status, no expiry, no account) and the offered models", () => {
    const view = modelsView(db(), null);
    expect(view.codex.configured).toBe(false);
    expect(view.codex.status).toContain("codex is not logged in");
    expect(view.codex.expiresAt).toBeNull();
    expect(view.codex.accountId).toBeNull();
    expect(view.codex.allowed).toBe(true);
    expect(view.codex.models).toEqual([{ id: "gpt-5.5", label: "GPT-5.5" }]);
  });

  it("carries expiry and the account id once a login exists", () => {
    const expiresAt = Date.now() + 30 * 86_400_000;
    saveCodexCredential(fakeCodexAuthJson(expiresAt, "org-123"));
    const view = modelsView(db(), null);
    expect(view.codex.configured).toBe(true);
    expect(view.codex.status).toBeNull();
    expect(view.codex.expiresAt).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(view.codex.accountId).toBe("org-123");
  });

  it("a personal login carries no account id", () => {
    saveCodexCredential(fakeCodexAuthJson(Date.now() + 30 * 86_400_000));
    expect(modelsView(db(), null).codex.accountId).toBeNull();
  });

  it("honours the project harness allow-list", () => {
    db().insert(projects).values({ id: "p_cv", name: "CV", createdAt: 0 }).onConflictDoNothing().run();
    db().update(projects).set({ allowedHarnesses: JSON.stringify(["pi"]) }).where(eq(projects.id, "p_cv")).run();
    const view = modelsView(db(), "p_cv");
    expect(view.codex.allowed).toBe(false);
    expect(view.cursor.allowed).toBe(false);
    expect(view.piAllowed).toBe(true);
  });
});
