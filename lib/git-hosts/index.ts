import type { GitCredential } from "@/db/schema";
import type { SandboxShell } from "@/lib/sandbox-shell";

/**
 * Minimal shell surface GitHost implementations may use — the canonical
 * SandboxShell seam (lib/sandbox-shell.ts), re-exported so existing
 * imports keep working. Structural (not eve's SandboxSession) so hosts
 * are unit-testable against a fake.
 */
export type { SandboxShell };

/** Input for opening a pull/merge request (0004 Phase D). */
export interface CreatePRInput {
  /** Repo remote URL in any accepted form (https or ssh). */
  remoteUrl: string;
  /** Branch containing the work. */
  head: string;
  /** Target branch; defaults to the host's default ("main"). */
  base?: string;
  title: string;
  body?: string;
}

export interface CreatePRResult {
  /** Web URL of the opened pull request. */
  url: string;
  /** PR number as assigned by the host (both APIs return it). */
  number: number;
}

/**
 * The pluggable VCS seam (0004): projects and repos never know which
 * implementation serves them — credentials resolve by host, auth installs
 * into a session sandbox, and provider-specific actions (createPR, …)
 * live here, exposed to the agent as thin tools.
 */
export interface GitHost {
  readonly kind: GitCredential["kind"];
  /** Does this credential's host scope cover the given remote URL? */
  matchesHost(remoteUrl: string, credential: GitCredential): boolean;
  /** Install the credential into the sandbox so git can authenticate. */
  installAuth(sandbox: SandboxShell, credential: GitCredential): Promise<void>;
  /** Open a pull request. `fetchImpl` is injectable for tests. */
  createPR(
    credential: GitCredential,
    input: CreatePRInput,
    fetchImpl?: typeof fetch,
  ): Promise<CreatePRResult>;
}

/** Parse {host, owner, repo} from an https or ssh remote URL. */
export function repoPath(
  remoteUrl: string,
): { host: string; owner: string; repo: string } | null {
  const host = remoteHost(remoteUrl);
  if (!host) return null;
  const match = remoteUrl.match(/[/:]([^/]+)\/([^/#?]+?)(?:\.git)?$/);
  if (!match) return null;
  return { host, owner: match[1], repo: match[2] };
}

/** POST JSON and require a 2xx, surfacing the provider's error body. */
export async function postJSON(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json: Record<string, unknown> = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const message =
      typeof json.message === "string" ? json.message : res.statusText;
    throw new Error(`${url} → ${res.status}: ${message}`);
  }
  return json;
}

/** Extract the hostname from an https or ssh remote URL. */
export function remoteHost(remoteUrl: string): string | null {
  const https = remoteUrl.match(/^https?:\/\/(?:[^/@]+@)?([^/:?#]+)/);
  if (https) return https[1].toLowerCase();
  const ssh = remoteUrl.match(/^[\w.-]+@([^/:?#]+):/);
  if (ssh) return ssh[1].toLowerCase();
  return null;
}

/** Normalize an ssh remote (git@host:path) to https for credential-store auth. */
export function httpsRemote(remoteUrl: string): string {
  const ssh = remoteUrl.match(/^[\w.-]+@([^:]+):(.+)$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return remoteUrl;
}

/** One git-credential-store line for host, URL-encoding user and secret. */
export function credentialStoreLine(
  host: string,
  username: string,
  secret: string,
): string {
  return `https://${encodeURIComponent(username)}:${encodeURIComponent(secret)}@${host}`;
}

/** sed-safe form of a host (escape regex dots) for dedup deletions. */
function sedLiteral(host: string): string {
  return host.replace(/\./g, "\\.");
}

/**
 * Install `credential.helper store` plus one host line into the sandbox's
 * /workspace/.git-credentials (idempotent per host: the previous line for
 * the host is removed first). Shared by hosts that authenticate with a
 * username + token over https — currently github and forgejo.
 */
export async function installCredentialStore(
  sandbox: SandboxShell,
  host: string,
  credential: GitCredential,
): Promise<void> {
  const helper = await sandbox.run(
    "git config --global credential.helper 'store --file=/workspace/.git-credentials'",
  );
  if (helper.exitCode !== 0) throw new Error(helper.stderr);

  // base64 transport avoids every shell-quoting hazard for secrets.
  const line = credentialStoreLine(host, credential.username, credential.secret);
  const encoded = Buffer.from(`${line}\n`).toString("base64");
  const result = await sandbox.run(
    `touch /workspace/.git-credentials && ` +
      `sed -i '\\#${sedLiteral(host)}#d' /workspace/.git-credentials && ` +
      `printf %s '${encoded}' | base64 -d >> /workspace/.git-credentials`,
  );
  if (result.exitCode !== 0) throw new Error(result.stderr);
}

/**
 * Resolve a remote URL to (host implementation, credential) using the
 * host-scope rule: github credentials cover github.com; forgejo
 * credentials cover their instance host. First matching credential wins.
 */
export function resolveCredential(
  remoteUrl: string,
  credentials: readonly GitCredential[],
  hosts: readonly GitHost[],
): { host: GitHost; credential: GitCredential } | undefined {
  for (const credential of credentials) {
    const host = hosts.find((h) => h.kind === credential.kind);
    if (host?.matchesHost(remoteUrl, credential)) {
      return { host, credential };
    }
  }
  return undefined;
}
