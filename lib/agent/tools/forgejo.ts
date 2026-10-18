import { db } from "@/db";
import { listGitCredentials } from "@/db/projects";
import { clipHead } from "@/lib/clip";

/**
 * 0033 Phase A′: the forgejo core — read-only REST against the
 * self-hosted instance, on the stored forgejo credential (Basic auth
 * with the PAT, the same convention as the GitHost seam). The gh tool's
 * twin: allowlisted GET paths, value-shaped errors that carry the
 * allowlist, output clipped, the secret scrubbed from every result.
 *
 * (Why not the `tea` CLI — it exists and mostly speaks Forgejo's API,
 * but wants a configured login rather than a per-call credential and
 * has a spotty release cadence; six GET endpoints are smaller and
 * safer as fetch. Swap is contained if this ever frictions.)
 */

/** Read-only API path patterns (everything else is refused). */
const ALLOWED_PATTERNS: [RegExp, string][] = [
  [/^\/repos\/search$/, "/repos/search?q=…"],
  [/^\/orgs\/[a-z0-9_.-]+\/repos$/, "/orgs/{org}/repos"],
  [/^\/users\/[a-z0-9_.-]+\/repos$/, "/users/{user}/repos"],
  [/^\/repos\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/, "/repos/{owner}/{repo}"],
  [/^\/repos\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/branches$/, "/repos/{o}/{r}/branches"],
  [/^\/repos\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/issues$/, "/repos/{o}/{r}/issues"],
  [/^\/repos\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/issues\/\d+$/, "/repos/{o}/{r}/issues/{n}"],
  [/^\/repos\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/pulls$/, "/repos/{o}/{r}/pulls"],
  [/^\/repos\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/pulls\/\d+$/, "/repos/{o}/{r}/pulls/{n}"],
  [/^\/repos\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/releases$/, "/repos/{o}/{r}/releases"],
  [/^\/user$/, "/user"],
];

const ALLOWED_LIST = ALLOWED_PATTERNS.map(([, label]) => label);

const TIMEOUT_MS = 20_000;
const MAX_OUTPUT = 20_000;

export type ForgejoResult =
  | { ok: true; url: string; output: string }
  | { ok: false; code: string; message: string; allowed: string[] };

export function allowedForgejoPaths(): string[] {
  return ALLOWED_LIST;
}

export async function runForgejo(
  path: string,
  params: Record<string, string> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<ForgejoResult> {
  const clean = path.trim();
  if (!ALLOWED_PATTERNS.some(([re]) => re.test(clean))) {
    return {
      ok: false,
      code: "not-allowed",
      message: `"${clean}" is not a read-only forgejo API path (GET only).`,
      allowed: ALLOWED_LIST,
    };
  }

  const credential = listGitCredentials(db()).find((c: { kind: string }) => c.kind === "forgejo");
  if (!credential || !credential.baseUrl) {
    return {
      ok: false,
      code: "not-configured",
      message: "No forgejo credential (with base URL) is stored on this server.",
      allowed: ALLOWED_LIST,
    };
  }

  const base = credential.baseUrl.replace(/\/$/, "");
  const query = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => typeof v === "string" && v.length > 0)),
  );
  const url = `${base}/api/v1${clean}${query.size > 0 ? `?${query}` : ""}`;
  const basic = Buffer.from(`${credential.username}:${credential.secret}`).toString("base64");

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { authorization: `Basic ${basic}`, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      code: "network",
      message: `Request failed: ${err instanceof Error ? err.message : String(err)}`,
      allowed: ALLOWED_LIST,
    };
  }

  const text = await response.text();
  const scrubbed = text.split(credential.secret).join("***");
  if (!response.ok) {
    return {
      ok: false,
      code: "http-error",
      message: `HTTP ${response.status}: ${clipHead(scrubbed, 400)}`,
      allowed: ALLOWED_LIST,
    };
  }
  return { ok: true, url, output: clipHead(scrubbed.trim(), MAX_OUTPUT) };
}
