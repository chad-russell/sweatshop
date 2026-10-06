import { NextResponse } from "next/server";
import { db } from "@/db";
import { listGitCredentials, listProjectRepos } from "@/db/projects";
import { listRemoteBranches } from "@/lib/git-hosts/branches";

export const dynamic = "force-dynamic";

/**
 * 0017: a project's repos and, with `?repo=<id>`, that repo's remote
 * branches. Listing failures surface as a `warning` (the form falls
 * back to a typed branch name) instead of a silently empty list.
 */
export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const repos = listProjectRepos(db(), projectId).map(({ id, name, url }) => ({ id, name, url }));
  const repo = new URL(request.url).searchParams.get("repo");
  const target = repo ? repos.find((r) => r.id === repo) : undefined;
  const listed = target
    ? await listRemoteBranches(target.url, listGitCredentials(db()))
    : { branches: [], warning: null };
  return NextResponse.json({ repos, ...listed });
}
