import { NextResponse } from "next/server";
import { db } from "@/db";
import type { GitCredential } from "@/db/schema";
import { gitCredentials } from "@/db/schema";
import { GIT_HOSTS } from "@/lib/git-hosts/hosts";
import { resolveCredential, type PRState } from "@/lib/git-hosts";

export const dynamic = "force-dynamic";

/** 0052: the phase chip asks about one PR, a transcript about a few —
 *  past this the request is someone else's problem. */
const MAX_URLS = 10;

/** owner/repo/number off a PR web URL — hosts say `pull`, Forgejo says
 *  `pulls` (`…/owner/repo/pull/123`, `…/owner/repo/pulls/123/files`). */
function prCoords(
  url: string,
): { host: string; owner: string; repo: string; number: number } | null {
  const match = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pulls?\/(\d+)/);
  if (!match) return null;
  return { host: match[1].toLowerCase(), owner: match[2], repo: match[3], number: Number(match[4]) };
}

/** One PR URL → its live state, or null when nothing can answer it. */
async function prStateFor(
  url: string,
  credentials: readonly GitCredential[],
): Promise<PRState | null> {
  const coords = prCoords(url);
  if (!coords) return null;
  // resolveCredential matches by host — synthesize the remote the
  // credential's scope rule can see (owner/repo ride along for the API).
  const remoteUrl = `https://${coords.host}/${coords.owner}/${coords.repo}`;
  const resolved = resolveCredential(remoteUrl, credentials, GIT_HOSTS);
  if (!resolved) return null;
  try {
    return await resolved.host.getPRState(resolved.credential, remoteUrl, coords.number);
  } catch {
    return null; // getPRState never throws; the route still never 500s
  }
}

/** Live PR lifecycle states (0052), batched: `?url=<PR web url>`
 *  repeatable, answered as `{ [url]: { state, mergedAt? } | null }`
 *  keyed by the exact input URL. An unresolvable URL maps to null. */
export async function GET(request: Request) {
  const urls = new URL(request.url).searchParams.getAll("url").slice(0, MAX_URLS);
  const credentials = db().select().from(gitCredentials).all();
  const entries = await Promise.all(
    urls.map(async (url) => [url, await prStateFor(url, credentials)] as const),
  );
  return NextResponse.json(Object.fromEntries(entries));
}
