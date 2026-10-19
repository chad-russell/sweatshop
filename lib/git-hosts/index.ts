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

/** A PR's lifecycle state on its host (0052) — asked live, never stored. */
export interface PRState {
  state: "open" | "merged" | "closed";
  /** When the host reports the merge (ISO timestamp, when it has one). */
  mergedAt?: string;
}

/**
 * One PR as a host lists it (0053) — asked live for the dashboard,
 * never stored. Author filtering is the caller's job (the seam stays
 * dumb), so rows include PRs by anyone.
 */
export interface PRSummary {
  number: number;
  title: string;
  /** Web URL of the pull request. */
  url: string;
  state: "open" | "merged" | "closed";
  /** Branch name carrying the work. */
  head: string;
  /** Author's host login. */
  author: string;
  /** ISO. */
  createdAt: string;
  /** ISO (any activity: commits, comments, reviews). */
  updatedAt: string;
  /** Aggregated review verdict (null where the host/API can't answer;
   *  settled PRs are never asked). */
  reviewState: "changes-requested" | "approved" | "commented" | null;
  /** Issue-style comment threads. */
  commentCount: number | null;
  /** Newest review timestamp, when any. */
  lastReviewAt: string | null;
}

/** One host review row, normalized for aggregation (0053). */
export interface ReviewSignal {
  /** Reviewer's host login. */
  reviewer: string;
  /** The review's verdict, host-mapped onto the summary vocabulary. */
  state: Exclude<PRSummary["reviewState"], null>;
  /** ISO submitted-at; null sorts oldest (a review without a timestamp
   *  can't claim to be anyone's latest). */
  submittedAt: string | null;
}

/** Review fetches are bounded (0053): open PRs past this count per repo
 *  get `reviewState: null` — the personal case never approaches it. */
export const MAX_REVIEWED_PRS = 25;

/** How strongly a verdict asks for the author's attention (0053):
 *  changes-requested > approved > commented when reviewers disagree. */
const REVIEW_RANK: Record<ReviewSignal["state"], number> = {
  "changes-requested": 2,
  approved: 1,
  commented: 0,
};

/**
 * Aggregate review rows into a PR's verdict (0053): per reviewer the
 * latest review (by submitted_at) wins, then across reviewers
 * changes-requested beats approved beats commented; lastReviewAt is the
 * newest submitted_at. Pure — pinned by tests.
 */
export function aggregateReviews(
  reviews: readonly ReviewSignal[],
): Pick<PRSummary, "reviewState" | "lastReviewAt"> {
  let lastReviewAt: string | null = null;
  const latestByReviewer = new Map<string, ReviewSignal>();
  for (const review of reviews) {
    if (review.submittedAt && (!lastReviewAt || review.submittedAt > lastReviewAt)) {
      lastReviewAt = review.submittedAt;
    }
    const prior = latestByReviewer.get(review.reviewer);
    if (!prior || (review.submittedAt ?? "") > (prior.submittedAt ?? "")) {
      latestByReviewer.set(review.reviewer, review);
    }
  }
  let verdict: ReviewSignal["state"] | null = null;
  for (const { state } of latestByReviewer.values()) {
    if (verdict === null || REVIEW_RANK[state] > REVIEW_RANK[verdict]) verdict = state;
  }
  return { reviewState: verdict, lastReviewAt };
}

/** The `login` inside a host's actor object (`user`, `poster`, `reviewer`). */
export function actorLogin(actor: unknown): string | null {
  if (typeof actor !== "object" || actor === null) return null;
  const login = (actor as Record<string, unknown>).login;
  return typeof login === "string" ? login : null;
}

/** The branch name inside a host's head object (`{ref, sha, repo…}`). */
export function headRef(head: unknown): string | null {
  if (typeof head !== "object" || head === null) return null;
  const ref = (head as Record<string, unknown>).ref;
  return typeof ref === "string" ? ref : null;
}

/** A JSON field of a row (typed narrow for object payloads). */
export function jsonField(row: unknown, key: string): unknown {
  if (typeof row !== "object" || row === null) return null;
  return (row as Record<string, unknown>)[key];
}

/** A string field of a JSON row, or null (the row's shape is untrusted). */
export function strField(row: unknown, key: string): string | null {
  const value = jsonField(row, key);
  return typeof value === "string" ? value : null;
}

/**
 * The shared listPRs driver (0053): list a repo's PRs, then aggregate a
 * review verdict per OPEN PR by the credential's account (one reviews
 * call each, bounded to MAX_REVIEWED_PRS — settled and foreign PRs are
 * never asked). Hosts supply their row parsers and endpoint URLs.
 * Returns null on any list failure — never throws (mirrors getPRState).
 */
export async function listPRsWithReviews(args: {
  listUrl: string;
  reviewsUrl: (number: number) => string;
  headers: Record<string, string>;
  /** The account whose PRs get review verdicts. */
  username: string;
  parsePR: (row: unknown) => PRSummary | null;
  parseReview: (row: unknown) => ReviewSignal | null;
  fetchImpl: typeof fetch;
}): Promise<PRSummary[] | null> {
  try {
    const list = await getJSON(args.listUrl, args.headers, args.fetchImpl);
    if (!Array.isArray(list)) return null; // shape error
    const prs = list.map(args.parsePR).filter((pr): pr is PRSummary => pr !== null);
    const askReviews = prs
      .filter(
        (pr) =>
          pr.state === "open" &&
          pr.author.toLowerCase() === args.username.toLowerCase(),
      )
      .slice(0, MAX_REVIEWED_PRS);
    const verdicts = await Promise.all(
      askReviews.map(async (pr): Promise<Pick<PRSummary, "reviewState" | "lastReviewAt"> | null> => {
        try {
          const rows = await getJSON(args.reviewsUrl(pr.number), args.headers, args.fetchImpl);
          if (!Array.isArray(rows)) return null;
          return aggregateReviews(
            rows.map(args.parseReview).filter((s): s is ReviewSignal => s !== null),
          );
        } catch {
          return null; // one failed reviews call never sinks the list
        }
      }),
    );
    askReviews.forEach((pr, i) => {
      if (verdicts[i]) Object.assign(pr, verdicts[i]);
    });
    return prs;
  } catch {
    return null; // non-2xx, network, or parse failure — unknown, never thrown
  }
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
  /** The PR's live lifecycle state, or null when unknown (a not-found
   *  PR, a host error, an unparseable answer) — never throws (0052). */
  getPRState(
    credential: GitCredential,
    remoteUrl: string,
    number: number,
    fetchImpl?: typeof fetch,
  ): Promise<PRState | null>;
  /** The repo's PRs as the host lists them (0053) — open PRs by the
   *  credential's account carry an aggregated review verdict — or null
   *  when the host can't be asked; never throws (mirrors getPRState). */
  listPRs(
    credential: GitCredential,
    remoteUrl: string,
    fetchImpl?: typeof fetch,
  ): Promise<PRSummary[] | null>;
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

/** GET and require a 2xx, surfacing the provider's error body (0052). */
export async function getJSON(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, { headers });
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
