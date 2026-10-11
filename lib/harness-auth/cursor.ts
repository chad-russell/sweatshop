import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 0038: the Cursor credential — the browser-login `auth.json` that
 * `agent login` writes (`{accessToken, refreshToken}`, JWTs). Held by the
 * app under `data/harness-auth/cursor/auth.json` (0600; `HARNESS_AUTH_DIR`
 * relocates the root; under `data/`, so restic already covers it; never
 * in git, never in the DB, never logged).
 *
 * THE one seam: everything that needs Cursor's credential goes through
 * `cursorCredential()`, so the later in-app Connect flow (log in through
 * the site, store the result here) replaces how the file arrives, not who
 * reads it.
 *
 * Why a FILE and not an env var (spiked, docs/0038): the access token is
 * rejected as `CURSOR_API_KEY` ("API key is invalid") and ignored as
 * `CURSOR_AUTH_TOKEN`; only the CLI's own auth.json authenticates it.
 */

export function harnessAuthRoot(): string {
  return process.env.HARNESS_AUTH_DIR ?? path.join(process.cwd(), "data", "harness-auth");
}

export function cursorAuthPath(): string {
  return path.join(harnessAuthRoot(), "cursor", "auth.json");
}

export type CursorCredential =
  | {
      ok: true;
      /** The file's exact text — planted into the sandbox as-is. */
      json: string;
      /** Access-token expiry (ms epoch) when the JWT carries one. */
      expiresAt: number | null;
    }
  | { ok: false; reason: "missing" | "invalid" | "expired"; message: string };

/** Refuse a credential this close to expiry — a turn would die mid-way. */
export const EXPIRY_MARGIN_MS = 60 * 60 * 1000;

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
export function parseCursorAuth(text: string, now: number = Date.now()): CursorCredential {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid", message: "cursor auth.json is not valid JSON" };
  }
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const access = record?.accessToken;
  const refresh = record?.refreshToken;
  if (typeof access !== "string" || !access || typeof refresh !== "string" || !refresh) {
    return {
      ok: false,
      reason: "invalid",
      message: "cursor auth.json needs accessToken and refreshToken (the file `agent login` writes)",
    };
  }
  const expiresAt = jwtExpiry(access);
  if (expiresAt !== null && expiresAt - now < EXPIRY_MARGIN_MS) {
    return {
      ok: false,
      reason: "expired",
      message: `cursor login expired ${new Date(expiresAt).toISOString().slice(0, 10)} — run \`agent login\` again and replace the saved auth.json`,
    };
  }
  return { ok: true, json: text, expiresAt };
}

/**
 * Read the stored credential (never throws; value-shaped). Synchronous on
 * purpose: route validation (`validationContext`) is sync and runs in
 * steps and routes alike, and this is one tiny local file.
 */
export function cursorCredential(now: number = Date.now()): CursorCredential {
  let text: string;
  try {
    text = readFileSync(cursorAuthPath(), "utf8");
  } catch {
    return {
      ok: false,
      reason: "missing",
      message: `cursor is not logged in — run \`agent login\` and save its auth.json at ${cursorAuthPath()}`,
    };
  }
  return parseCursorAuth(text, now);
}

/** Availability check (route validation, the tool gate, /settings). */
export function cursorConfigured(): boolean {
  return cursorCredential().ok;
}

/** Validate then store (0600, atomic) — what a future Connect flow calls. */
export function saveCursorCredential(text: string, now: number = Date.now()): CursorCredential {
  const parsed = parseCursorAuth(text, now);
  if (!parsed.ok) return parsed;
  const target = cursorAuthPath();
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, target);
  return parsed;
}

export function clearCursorCredential(): void {
  rmSync(cursorAuthPath(), { force: true });
}

/** File mtime for status displays (never contents); null when absent. */
export function cursorCredentialSavedAt(): number | null {
  try {
    return statSync(cursorAuthPath()).mtimeMs;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Planting into a sandbox
// ---------------------------------------------------------------------------

/**
 * Where the Cursor CLI reads its credential inside the sandbox: the
 * adapter runs it under a private HOME inside its state directory
 * (`<sandbox HOME>/.ai-sdk-harness/.harness-bootstrap/cursor/
 * implementation/home`, verified in the spike); on linux the CLI reads
 * `$XDG_CONFIG_HOME` or `$HOME/.config` → `cursor/auth.json`.
 */
export const CURSOR_PRIVATE_HOME_SUFFIX =
  ".ai-sdk-harness/.harness-bootstrap/cursor/implementation/home";

export interface PlantShell {
  run(
    command: string,
    env?: Record<string, string>,
    workingDirectory?: string,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/**
 * Plant the credential in the sandbox, before every turn: the host copy
 * is the source of truth, and the in-sandbox file is a cache (a CLI
 * refresh there must not strand the host's). The JSON rides in an env
 * var (base64) — never argv, never a log. `$HOME` expands inside the
 * sandbox shell, so no home path is guessed from the host.
 */
export async function plantCursorCredential(
  sandbox: PlantShell,
  json: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const dir = `"$HOME/${CURSOR_PRIVATE_HOME_SUFFIX}/.config/cursor"`;
  const result = await sandbox.run(
    `mkdir -p ${dir} && printf %s "$CURSOR_AUTH_B64" | base64 -d > ${dir}/auth.json && chmod 600 ${dir}/auth.json`,
    { CURSOR_AUTH_B64: Buffer.from(json).toString("base64") },
    "/",
  );
  return result.exitCode === 0
    ? { ok: true }
    : { ok: false, message: `could not plant the cursor credential: ${result.stderr.trim() || `exit ${result.exitCode}`}` };
}
