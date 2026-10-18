import { saveCodexCredential, type CodexCredential } from "./codex";

/** The saved shape only — approval always carries the ok variant. */
type SavedCredential = Extract<CodexCredential, { ok: true }>;

/**
 * 0050 phase 5: the codex CLI's OAuth device flow, reimplemented
 * server-side so a subscription login happens in Chad's own browser —
 * no CLI in the app process, no local callback server. Every endpoint
 * and response shape here was read off the codex CLI source
 * (codex-rs/login/src/{device_code_auth,server,auth/manager}.rs), not
 * off public docs; anything marked "source-inferred" may need the
 * spike (CODEX_SPIKE, phase 6) to confirm. The flow:
 *
 *   1. POST {issuer}/api/accounts/deviceauth/usercode {client_id}
 *      → {user_code, device_auth_id, interval}
 *   2. The user opens {issuer}/codex/device in their browser and
 *      approves the code (enterprise SSO picks the workspace there —
 *      that choice is what makes the account id enterprise-correct).
 *   3. Poll POST {issuer}/api/accounts/deviceauth/token
 *      {device_auth_id, user_code}. Approval returns the
 *      authorization_code AND the PKCE code_verifier — the server does
 *      the PKCE (source-inferred), so no local secret is held.
 *   4. Exchange at {issuer}/oauth/token (grant authorization_code,
 *      redirect {issuer}/deviceauth/callback) → access/refresh/id
 *      tokens; the id_token's chatgpt_account_id claim (absent on
 *      personal accounts) becomes tokens.account_id.
 *   5. Compose the CLI's own auth.json shape and hand it to
 *      saveCodexCredential (validate → 0600 atomic write).
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

/** POST JSON and parse JSON defensively — the issuer's exact response
 *  shapes are source-inferred, so every field is checked, never assumed. */
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
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = {};
  }
  const object = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  return { ok: true, status: res.status, body: object };
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
    // Approved — step 4: the exchange (redirect is the issuer's own
    // device-flow callback; source-inferred constant of the flow, our
    // client never listens on it).
    const exchange = await postJson(doFetch, `${issuer}/oauth/token`, {
      grant_type: "authorization_code",
      client_id: CODEX_LOGIN_CLIENT_ID,
      code: authorizationCode,
      redirect_uri: `${issuer}/deviceauth/callback`,
      code_verifier: codeVerifier,
    });
    if (!exchange.ok) return { ok: false, message: exchange.message };
    if (exchange.status !== 200) {
      return { ok: false, message: `token exchange failed (HTTP ${exchange.status})` };
    }
    const accessToken = str(exchange.body.access_token);
    const refreshToken = str(exchange.body.refresh_token);
    const idToken = str(exchange.body.id_token);
    if (!accessToken || !refreshToken) {
      return { ok: false, message: "token exchange response was missing access_token or refresh_token" };
    }
    // No signature check: the id_token arrived directly from the issuer
    // over TLS, same trust the CLI gives it — we only read a claim.
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
    return { ok: true, status: "approved", credential };
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
