import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EXPIRY_MARGIN_MS, harnessAuthRoot } from "./cursor";
export { EXPIRY_MARGIN_MS } from "./cursor";

/**
 * 0050: the Codex credential — the ChatGPT-login `auth.json` that
 * `codex login` writes (`{auth_mode:"chatgpt", tokens:{access_token,
 * refresh_token, account_id?}, last_refresh?}`). Held by the app under
 * `data/harness-auth/codex/auth.json` (0600; `HARNESS_AUTH_DIR` relocates
 * the root; under `data/`, so restic already covers it; never in git,
 * never in the DB, never logged).
 *
 * THE one seam: everything that needs Codex's credential goes through
 * `codexCredential()`, so the later in-app login (device code, 0050
 * phase 5) replaces how the file arrives, not who reads it.
 *
 * Why a FILE and nothing planted (docs/0050, unlike cursor 0038): auth
 * is env-carried, not file-carried — the adapter resolves the
 * subscription from `CODEX_HOME/auth.json` in the app process and
 * forwards `CODEX_API_KEY` to the bridge, so no copy ever enters a
 * sandbox. The adapter also refreshes near-expiry tokens itself and
 * writes them back to that same file.
 */

export function codexAuthPath(): string {
  return path.join(harnessAuthRoot(), "codex", "auth.json");
}

export type CodexCredential =
  | {
      /** The file's exact text — the adapter reads it back via CODEX_HOME. */
      ok: true;
      json: string;
      /** Access-token expiry (ms epoch) when the JWT carries one. */
      expiresAt: number | null;
      /** The enterprise workspace id (`tokens.account_id`) when present. */
      accountId: string | null;
    }
  | { ok: false; reason: "missing" | "invalid" | "expired"; message: string };

function jwtExpiry(token: string): number | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Parse + judge an auth.json text. Pure (tested without the filesystem). */
export function parseCodexAuth(text: string, now: number = Date.now()): CodexCredential {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid", message: "codex auth.json is not valid JSON" };
  }
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const tokens = record?.tokens && typeof record.tokens === "object" ? (record.tokens as Record<string, unknown>) : null;
  const access = tokens?.access_token;
  const refresh = tokens?.refresh_token;
  const account = tokens?.account_id;
  if (
    record?.auth_mode !== "chatgpt" ||
    typeof access !== "string" ||
    !access ||
    typeof refresh !== "string" ||
    !refresh ||
    (account !== undefined && (typeof account !== "string" || !account))
  ) {
    return {
      ok: false,
      reason: "invalid",
      message:
        'codex auth.json needs auth_mode "chatgpt" with tokens.access_token and tokens.refresh_token (the file `codex login` writes)',
    };
  }
  const expiresAt = jwtExpiry(access);
  if (expiresAt !== null && expiresAt - now < EXPIRY_MARGIN_MS) {
    return {
      ok: false,
      reason: "expired",
      message: `codex login expired ${new Date(expiresAt).toISOString().slice(0, 10)} — use Log in with ChatGPT on /settings, or replace the saved auth.json`,
    };
  }
  return { ok: true, json: text, expiresAt, accountId: typeof account === "string" ? account : null };
}

/**
 * Read the stored credential (never throws; value-shaped). Synchronous on
 * purpose, like cursor's: route validation is sync and reads this file.
 */
export function codexCredential(now: number = Date.now()): CodexCredential {
  let text: string;
  try {
    text = readFileSync(codexAuthPath(), "utf8");
  } catch {
    return {
      ok: false,
      reason: "missing",
      message: `codex is not logged in — use Log in with ChatGPT on /settings, or save the auth.json \`codex login\` writes at ${codexAuthPath()}`,
    };
  }
  return parseCodexAuth(text, now);
}

/** Availability check (route validation, the tool gate, /settings). */
export function codexConfigured(): boolean {
  return codexCredential().ok;
}

/** Validate then store (0600, atomic) — what the login flow (0050) calls. */
export function saveCodexCredential(text: string, now: number = Date.now()): CodexCredential {
  const parsed = parseCodexAuth(text, now);
  if (!parsed.ok) return parsed;
  const target = codexAuthPath();
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, target);
  return parsed;
}

export function clearCodexCredential(): void {
  rmSync(codexAuthPath(), { force: true });
}

/** File mtime for status displays (never contents); null when absent. */
export function codexCredentialSavedAt(): number | null {
  try {
    return statSync(codexAuthPath()).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 0050: `CODEX_HOME` for the app process — our auth dir (the adapter
 * reads auth.json there and writes token refreshes back), unless an
 * operator already pointed it elsewhere, which wins. Pure;
 * instrumentation assigns the result at boot.
 */
export function resolveCodexHome(env: Readonly<Record<string, string | undefined>>): string | undefined {
  return env.CODEX_HOME ?? path.dirname(codexAuthPath());
}
