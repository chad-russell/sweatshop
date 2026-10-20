import type { Db } from "@/db";
import { gitCredentials, projectRepos, type GitCredential } from "@/db/schema";
import { GIT_HOSTS } from "@/lib/git-hosts/hosts";
import { resolveCredential, type GitHost, type PRSummary } from "@/lib/git-hosts";
import type { DashboardPR, PRDashboardData } from "@/lib/read-models/prs";

/**
 * 0053: the PR dashboard loader — every project repo, asked live through
 * the GitHost seam, filtered to PRs by the repo's own credential
 * (case-insensitive: host logins are), deduped by canonical URL (the
 * same repo can be in two projects). Open PRs first in needs-attention
 * order, settled (merged, then closed) dimmed below. A repo that can't
 * be asked is reported, never fatal — the page still renders.
 */

/** How the loader asks a host — injectable so tests pin assembly without
 *  a network seam (the default is the seam's own listPRs). */
export type ListPRsFn = (
  host: GitHost,
  credential: GitCredential,
  remoteUrl: string,
) => Promise<PRSummary[] | null>;

const askHost: ListPRsFn = (host, credential, remoteUrl) =>
  host.listPRs(credential, remoteUrl);

/** Canonical dedupe key for a PR web URL: lowercase host, no trailing
 *  slash — the same PR from two remotes (.git vs bare) is one row. */
function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

/** How loudly an OPEN PR asks for Chad (0053): changes requested first,
 *  then commented, then the rest (approved or unreviewed) — each by last
 *  activity. */
function openRank(pr: DashboardPR): number {
  if (pr.reviewState === "changes-requested") return 0;
  if (pr.reviewState === "commented") return 1;
  return 2;
}

/** ISO → ms (0 when unparseable — sorts oldest, never NaN-poisons). */
const at = (iso: string): number => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
};

/** PRSummary carries no merge time, so last activity (which the merge
 *  updates) is the settled order: merged before closed, newest first.
 *  URL is the final tiebreak so equal-activity rows (Map insertion is
 *  Promise.all completion order) can't swap between loads. */
function sortPRs(prs: DashboardPR[]): DashboardPR[] {
  const open = prs
    .filter((pr) => pr.state === "open")
    .sort(
      (a, b) =>
        openRank(a) - openRank(b) || at(b.updatedAt) - at(a.updatedAt) || a.url.localeCompare(b.url),
    );
  const settled = prs
    .filter((pr) => pr.state !== "open")
    .sort((a, b) =>
      a.state === b.state
        ? at(b.updatedAt) - at(a.updatedAt) || a.url.localeCompare(b.url)
        : a.state === "merged"
          ? -1
          : 1,
    );
  return [...open, ...settled];
}

export async function loadPRDashboard(
  db: Db,
  listPRs: ListPRsFn = askHost,
): Promise<PRDashboardData> {
  const repos = db.select().from(projectRepos).all();
  const credentials = db.select().from(gitCredentials).all();
  const byUrl = new Map<string, DashboardPR>();
  const failedRepos: PRDashboardData["failedRepos"] = [];
  let reposQueried = 0;

  await Promise.all(
    repos.map(async (repo) => {
      const resolved = resolveCredential(repo.url, credentials, GIT_HOSTS);
      if (!resolved) {
        failedRepos.push({ repo: repo.id, reason: `no git credential matches ${repo.url}` });
        return;
      }
      let prs: PRSummary[] | null;
      try {
        prs = await listPRs(resolved.host, resolved.credential, repo.url);
      } catch (error) {
        failedRepos.push({
          repo: repo.id,
          reason: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (!prs) {
        failedRepos.push({ repo: repo.id, reason: `the host could not be asked (${repo.url})` });
        return;
      }
      reposQueried++;
      for (const pr of prs) {
        if (pr.author.toLowerCase() !== resolved.credential.username.toLowerCase()) continue;
        const key = canonicalUrl(pr.url);
        if (!byUrl.has(key)) byUrl.set(key, pr);
      }
    }),
  );

  return { prs: sortPRs([...byUrl.values()]), reposQueried, failedRepos };
}
