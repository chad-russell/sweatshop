import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projectRepos } from "@/db/schema";
import { listRemoteBranches } from "@/lib/previews/branch";

export const dynamic = "force-dynamic";

/**
 * 0017: a project's repos and, with `?repo=<id>`, that repo's remote
 * branches. Listing failures surface as a `warning` (the form falls
 * back to a typed branch name) instead of a silently empty list.
 */
export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const repos = db()
    .select({ id: projectRepos.id, name: projectRepos.name, url: projectRepos.url })
    .from(projectRepos)
    .where(eq(projectRepos.projectId, projectId))
    .all();
  const repo = new URL(request.url).searchParams.get("repo");
  const listed = repo && repos.some((r) => r.id === repo) ? await listRemoteBranches(repo) : { branches: [], warning: null };
  return NextResponse.json({ repos, ...listed });
}
