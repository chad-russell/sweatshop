import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { saveCodexCredential, type CodexCredential } from "./codex";

/** The saved shape only — approval always carries the ok variant. */
type SavedCredential = Extract<CodexCredential, { ok: true }>;

/**
 * 0050 phases 5/5b: the codex CLI's OAuth logins, reimplemented
 * server-side so a subscription login happens in Chad's own browser —
 * no CLI in the app process. Every endpoint, response shape and byte
 * layout here was read off the codex CLI source (codex-rs/login/src/
 * {device_code_auth,server,auth/manager}.rs) and verified against the
 * shipped @openai/codex 0.155.0; anything marked "source-inferred"
 * may still need the spike (CODEX_SPIKE) to confirm. Two flows:
 *
 * BROWSER (5b, PRIMARY) — enterprises commonly BLOCK device-code auth
 * (Chad's workspace does — 2026-10-18 live), so the pi/claude-style
 * "open URL, paste the localhost redirect back" flow comes first:
 *   1. startCodexBrowserLogin builds the /authorize URL (PKCE S256 +
 *      state, exact CLI byte shape below) — the user signs in, picks
 *      the workspace, and the issuer lands them on
 *      http://localhost:1455/auth/callback?code=…&state=… — no local
 *      server listens (the CLI's port 1455 trick skipped); the user
 *      pastes that URL back.
 *   2. completeCodexBrowserLogin checks state (constant-time), then
 *      exchanges the code (form-encoded — see below), reads
 *      chatgpt_account_id from the id_token, composes auth.json and
 *      saves it.
 *
 * DEVICE (5, kept as a disclosure) — startCodexDeviceLogin +
 * pollCodexDeviceLogin; the issuer hands back the authorization_code
 * AND the PKCE verifier (server-side PKCE), then the SAME exchange.
 *
 * The exchange is FORM-ENCODED, not JSON: the CLI's
 * exchange_code_for_tokens (used by both flows) sends
 * application/x-www-form-urlencoded (TokenEncoding::Form) — we match
 * the CLI byte-for-byte even where the issuer might accept JSON.
 *
 * Tokens never appear in messages or logs — errors carry the issuer's
 * HTTP status and error-field names only.
 */

/** The codex CLI's own OAuth client id — the same id the adapter uses
 *  for refresh (checked against @ai-sdk/harness-codex's auth manager),
 *  so an auth.json composed here refreshes exactly like the CLI's. */
export const CODEX_LOGIN_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** Tests and the spike point the whole flow at a fake issuer. */
export function codexLoginIssuer(): string {
  return (process.env.CODEX_LOGIN_ISSUER ?? "https://auth.openai.com").replace(/\/+$/, "");
}

/** The device code is only valid so long — the CLI gives up around ten
 *  minutes; the give-up stamp rides in the handle so the BROWSER (which
 *  holds the handle and drives the polling) stops on its own. */
export const CODEX_LOGIN_WINDOW_MS = 10 * 60 * 1000;

/** The pure client-held login state — posted back verbatim on every
 *  poll. The server keeps no session: statelessness between requests is
 *  the whole design (each poll = one issuer poll). */
export interface CodexLoginHandle {
  deviceAuthId: string;
  userCode: string;
  /** Seconds between polls — widened (×1.5) on the issuer's slow_down. */
  interval: number;
  /** ms epoch give-up stamp. */
  expiresAt: number;
}

export type StartCodexDeviceLoginResult =
  | { ok: true; userCode: string; verificationUrl: string; handle: CodexLoginHandle }
  | { ok: false; message: string };

export type PollCodexDeviceLoginResult =
  | { ok: true; status: "pending"; handle: CodexLoginHandle }
  | { ok: true; status: "approved"; credential: SavedCredential }
  | { ok: false; message: string };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Parse a response's JSON defensively — the issuer's exact response
 *  shapes are source-inferred, so every field is checked, never assumed. */
async function parseJsonResponse(
  res: Response,
): Promise<{ ok: true; status: number; body: Record<string, unknown> } | { ok: false; message: string }> {
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = {};
  }
  const object = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  return { ok: true, status: res.status, body: object };
}

/** POST JSON (the device endpoints). */
async function postJson(
  doFetch: FetchLike,
  url: string,
  body: unknown,
): Promise<{ ok: true; status: number; body: Record<string, unknown> } | { ok: false; message: string }> {
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, message: `could not reach ${url} (${errorMessage(err)})` };
  }
  return parseJsonResponse(res);
}

/** POST application/x-www-form-urlencoded — the exchange encoding the
 *  CLI itself uses (TokenEncoding::Form in exchange_code_for_tokens);
 *  we match the shipped CLI byte-for-byte. */
async function postForm(
  doFetch: FetchLike,
  url: string,
  params: Record<string, string>,
): Promise<{ ok: true; status: number; body: Record<string, unknown> } | { ok: false; message: string }> {
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
  } catch (err) {
    return { ok: false, message: `could not reach ${url} (${errorMessage(err)})` };
  }
  return parseJsonResponse(res);
}

/** Step 1: ask the issuer for a device code. Everything the UI needs
 *  (code, verification URL, polling cadence) comes back in the value. */
export async function startCodexDeviceLogin(opts: { fetch?: FetchLike } = {}): Promise<StartCodexDeviceLoginResult> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const issuer = codexLoginIssuer();
  const res = await postJson(doFetch, `${issuer}/api/accounts/deviceauth/usercode`, {
    client_id: CODEX_LOGIN_CLIENT_ID,
  });
  if (!res.ok) return { ok: false, message: res.message };
  if (res.status !== 200) return { ok: false, message: `issuer refused the login start (HTTP ${res.status})` };
  const userCode = str(res.body.user_code);
  const deviceAuthId = str(res.body.device_auth_id);
  const interval = res.body.interval;
  if (!userCode || !deviceAuthId) {
    return { ok: false, message: "issuer's login response was missing user_code or device_auth_id" };
  }
  return {
    ok: true,
    userCode,
    verificationUrl: `${issuer}/codex/device`,
    handle: {
      deviceAuthId,
      userCode,
      interval: typeof interval === "number" && interval > 0 ? interval : 5,
      expiresAt: Date.now() + CODEX_LOGIN_WINDOW_MS,
    },
  };
}

/** Step 3: ONE poll per call. Pending widens nothing by itself;
 *  slow_down bumps the interval in the returned handle so the browser
 *  adjusts. Approved (approval code + server-side PKCE verifier came
 *  back) runs the exchange, composes auth.json, saves it, and returns
 *  the parsed credential — the file is the seam. */
export async function pollCodexDeviceLogin(
  handle: CodexLoginHandle,
  opts: { fetch?: FetchLike; now?: () => number } = {},
): Promise<PollCodexDeviceLoginResult> {
  const now = opts.now ?? Date.now;
  if (now() >= handle.expiresAt) {
    return { ok: false, message: "the login window expired — start the login again" };
  }
  const doFetch = opts.fetch ?? globalThis.fetch;
  const issuer = codexLoginIssuer();
  const poll = await postJson(doFetch, `${issuer}/api/accounts/deviceauth/token`, {
    device_auth_id: handle.deviceAuthId,
    user_code: handle.userCode,
  });
  if (!poll.ok) return { ok: false, message: poll.message };
  const authorizationCode = str(poll.body.authorization_code);
  const codeVerifier = str(poll.body.code_verifier);
  if (authorizationCode && codeVerifier) {
    // Approved — the shared exchange → compose → save. The redirect is
    // the issuer's own device-flow callback (source-inferred constant
    // of the flow; our client never listens on it).
    const saved = await exchangeAndSave(
      doFetch,
      issuer,
      { code: authorizationCode, codeVerifier, redirectUri: `${issuer}/deviceauth/callback` },
      now,
    );
    if (!saved.ok) return saved;
    return { ok: true, status: "approved", credential: saved.credential };
  }
  // Not approved yet — or a shape we did not expect (the error field
  // names below are source-inferred; a 200 without a code and without
  // an error reads as still-pending, never as failure).
  const error = str(poll.body.error);
  if (error === "slow_down") {
    return { ok: true, status: "pending", handle: { ...handle, interval: Math.ceil(handle.interval * 1.5) } };
  }
  if (error === "authorization_pending" || !error) {
    return { ok: true, status: "pending", handle };
  }
  // The issuer named the failure (expired_token, access_denied, …) —
  // report the name, never any token or code value.
  return { ok: false, message: `login failed — the issuer said "${error}"` };
}

/** 0050 phase 5b: the BROWSER flow's client-held state — like the
 *  device handle, a pure value the client keeps and posts back; the
 *  server holds no session. */
export interface CodexBrowserHandle {
  /** PKCE verifier (base64url, 64 random bytes) — the matching
   *  challenge is baked into the authorize URL. */
  codeVerifier: string;
  /** The anti-CSRF token echoed in the callback (?state=…). */
  state: string;
  /** What the exchange must echo (the CLI's registered redirect —
   *  localhost, not 127.0.0.1, matching the issuer registration). */
  redirectUri: string;
}

export type StartCodexBrowserLoginResult =
  | { ok: true; authorizeUrl: string; handle: CodexBrowserHandle }
  | { ok: false; message: string };

export type CompleteCodexBrowserLoginResult =
  | { ok: true; credential: SavedCredential }
  | { ok: false; message: string };

/** The CLI's registered loopback redirect — no local server listens on
 *  it in the app; the user pastes the landed-on URL back instead. */
const CODEX_BROWSER_REDIRECT_URI = "http://localhost:1455/auth/callback";

/** The scope string the shipped CLI sends, space-joined (%20-encoded
 *  in the URL — never +, which URLSearchParams would produce). */
const CODEX_BROWSER_SCOPE =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";

/** Phase 5b step 1: build the authorize URL in the CLI's exact byte
 *  shape (param order included — verified against @openai/codex
 *  0.155.0). Pure: no issuer call, no server state. */
export function startCodexBrowserLogin(): StartCodexBrowserLoginResult {
  const codeVerifier = randomBytes(64).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const handle: CodexBrowserHandle = { codeVerifier, state, redirectUri: CODEX_BROWSER_REDIRECT_URI };
  const params: [string, string][] = [
    ["response_type", "code"],
    ["client_id", CODEX_LOGIN_CLIENT_ID],
    ["redirect_uri", handle.redirectUri],
    ["scope", CODEX_BROWSER_SCOPE],
    ["code_challenge", codeChallenge],
    ["code_challenge_method", "S256"],
    ["id_token_add_organizations", "true"],
    ["codex_cli_simplified_flow", "true"],
    ["state", state],
    ["originator", "codex_cli_rs"],
  ];
  const authorizeUrl =
    `${codexLoginIssuer()}/authorize?` + params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return { ok: true, authorizeUrl, handle };
}

/** Phase 5b step 2: the user pasted back where the issuer landed them
 *  — accept the full localhost URL or a bare query string. State is
 *  checked constant-time, then the shared form-encoded exchange runs
 *  and the credential lands in the file. */
export async function completeCodexBrowserLogin(
  handle: CodexBrowserHandle,
  callbackUrl: string,
  opts: { fetch?: FetchLike; now?: () => number } = {},
): Promise<CompleteCodexBrowserLoginResult> {
  const trimmed = callbackUrl.trim();
  let code: string | null;
  let state: string | null;
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const query = new URL(trimmed).searchParams;
      code = query.get("code");
      state = query.get("state");
    } else {
      const query = new URLSearchParams(trimmed.startsWith("?") ? trimmed.slice(1) : trimmed);
      code = query.get("code");
      state = query.get("state");
    }
  } catch {
    return { ok: false, message: "that does not parse as the callback URL — paste the full localhost URL from the browser's address bar" };
  }
  if (!code) {
    return { ok: false, message: "the callback is missing the authorization code — paste the full localhost URL, not the authorize one" };
  }
  if (!state || !constantTimeEquals(state, handle.state)) {
    return { ok: false, message: "the callback does not match this login (wrong or stale state) — start again" };
  }
  return exchangeAndSave(
    opts.fetch ?? globalThis.fetch,
    codexLoginIssuer(),
    { code, codeVerifier: handle.codeVerifier, redirectUri: handle.redirectUri },
    opts.now ?? Date.now,
  );
}

/** Length-checked constant-time compare — no early-exit on the first
 *  differing byte. */
function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** The shared tail of BOTH flows: the form-encoded code exchange at
 *  {issuer}/oauth/token → tokens → auth.json → saved credential. */
async function exchangeAndSave(
  doFetch: FetchLike,
  issuer: string,
  input: { code: string; codeVerifier: string; redirectUri: string },
  now: () => number,
): Promise<CompleteCodexBrowserLoginResult> {
  const exchange = await postForm(doFetch, `${issuer}/oauth/token`, {
    grant_type: "authorization_code",
    client_id: CODEX_LOGIN_CLIENT_ID,
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  if (!exchange.ok) return exchange;
  if (exchange.status !== 200) {
    return { ok: false, message: `token exchange failed (HTTP ${exchange.status})` };
  }
  const accessToken = str(exchange.body.access_token);
  const refreshToken = str(exchange.body.refresh_token);
  const idToken = str(exchange.body.id_token);
  if (!accessToken || !refreshToken) {
    return { ok: false, message: "token exchange response was missing access_token or refresh_token" };
  }
  return composeAndSave(accessToken, refreshToken, idToken, now);
}

/** Compose the CLI's own auth.json (2-space pretty + trailing newline)
 *  and hand it to saveCodexCredential — validate → 0600 atomic write.
 *  No id_token signature check: it arrived directly from the issuer
 *  over TLS, same trust the CLI gives it — we only read a claim. */
function composeAndSave(
  accessToken: string,
  refreshToken: string,
  idToken: string | null,
  now: () => number,
): CompleteCodexBrowserLoginResult {
  const accountId = idTokenClaim(idToken, "chatgpt_account_id");
  const authJson =
    JSON.stringify(
      {
        auth_mode: "chatgpt",
        tokens: { access_token: accessToken, refresh_token: refreshToken, ...(accountId ? { account_id: accountId } : {}) },
        last_refresh: new Date(now()).toISOString(),
      },
      null,
      2,
    ) + "\n";
  const credential = saveCodexCredential(authJson, now());
  if (!credential.ok) return { ok: false, message: credential.message };
  return { ok: true, credential };
}

/** The id_token's payload (a JWT): base64url middle segment, no
 *  verification (see above). Returns null for absent/undecodable. */
function idTokenClaim(idToken: string | null, claim: string): string | null {
  if (!idToken) return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const value = parsed[claim];
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
