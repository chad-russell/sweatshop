import { db } from "@/db";
import { getPrWatchByCoords } from "@/db/pr-watches";
import { gitCredentials, type GitCredential } from "@/db/schema";
import { GIT_HOSTS } from "@/lib/git-hosts/hosts";
import { resolveCredential, type PRState } from "@/lib/git-hosts";

/**
 * 0052's PR-state resolution (was inline in GET /api/x/prs), extracted
 * for 0084: the create_pr registration path parses the opened PR's URL
 * into watch coordinates here, the wake sweep's PR pass asks the same
 * live question, and the route answers from a settled watch row without
 * a host fetch. Server-only (sqlite + the host seam).
 */

/** A PR's coordinates off its web URL. */
export interface PRCoords {
  /** Lowercase URL host, port included — credential scope + remote URL. */
  host: string;
  /** Scheme + host — the watch row's base_url (web-url reconstruction). */
  origin: string;
  owner: string;
  repo: string;
  number: number;
}

/** owner/repo/number off a PR web URL — hosts say `pull`, Forgejo says
 *  `pulls` (`…/owner/repo/pull/123`, `…/owner/repo/pulls/123/files`). */
export function prCoords(url: string): PRCoords | null {
  const match = url.match(/^(https?:\/\/[^/]+)\/([^/]+)\/([^/]+)\/pulls?\/(\d+)/);
  if (!match) return null;
  return {
    origin: match[1],
    host: match[1].replace(/^https?:\/\//, "").toLowerCase(),
    owner: match[2],
    repo: match[3],
    number: Number(match[4]),
  };
}

/**
 * One PR's live state through the credential seam (0052's resolver,
 * verbatim), or null when nothing can answer it. Never throws — a host
 * error is "unknown", never a 500.
 */
export async function livePRState(
  coords: Pick<PRCoords, "host" | "owner" | "repo" | "number">,
  credentials: readonly GitCredential[] = db().select().from(gitCredentials).all(),
): Promise<PRState | null> {
  // resolveCredential matches by host — synthesize the remote the
  // credential's scope rule can see (owner/repo ride along for the API).
  const remoteUrl = `https://${coords.host}/${coords.owner}/${coords.repo}`;
  const resolved = resolveCredential(remoteUrl, credentials, GIT_HOSTS);
  if (!resolved) return null;
  try {
    return await resolved.host.getPRState(resolved.credential, remoteUrl, coords.number);
  } catch {
    return null; // getPRState never throws; callers still never see one
  }
}

/**
 * One PR URL → its state for the client (the /api/x/prs route). 0084: a
 * SETTLED watch row answers from the row — merged/closed are terminal,
 * so the sweep's answer cannot go stale and the host is not asked. Open
 * or never-watched PRs are asked live as before.
 */
export async function prStateFor(
  url: string,
  credentials?: readonly GitCredential[],
): Promise<PRState | null> {
  const coords = prCoords(url);
  if (!coords) return null;
  const watch = getPrWatchByCoords(db(), coords.origin, coords.owner, coords.repo, coords.number);
  if (watch?.settledAt != null) {
    return {
      state: watch.state as "merged" | "closed",
      // The row records when the sweep saw it, not the host's own
      // merged_at — display-only, and only when the state is merged.
      ...(watch.state === "merged" ? { mergedAt: new Date(watch.settledAt).toISOString() } : {}),
    };
  }
  return livePRState(coords, credentials);
}
