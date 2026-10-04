import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projectRepos } from "@/db/schema";
import { listRemoteBranches } from "@/lib/previews/branch";

export const dynamic = "force-dynamic";

/**
 * 0016: a project's repos and, with `?repo=<id>`, that repo's remote
 * branches (empty when the host can't be listed — the form then takes a
 * typed branch name).
 */
export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const repos = db()
    .select({ id: projectRepos.id, name: projectRepos.name, url: projectRepos.url })
    .from(projectRepos)
    .where(eq(projectRepos.projectId, projectId))
    .all();
  const repo = new URL(request.url).searchParams.get("repo");
  const branches = repo && repos.some((r) => r.id === repo) ? await listRemoteBranches(repo) : [];
  return NextResponse.json({ repos, branches });
}
