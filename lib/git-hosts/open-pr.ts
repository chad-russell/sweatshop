import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { gitCredentials, projectRepos } from "@/db/schema";
import { GIT_HOSTS } from "./hosts";
import { resolveCredential } from "./index";

/**
 * 0004 Phase D core, shared by the eve `create_pr` tool and machine
 * harness stages (0009): resolve project → repo → host-scoped credential,
 * then open the PR through the GitHost seam.
 */
export async function openProjectPR(args: {
  projectId: string;
  repo: string;
  head: string;
  base?: string;
  title: string;
  body?: string;
}) {
  const repoRow = db()
    .select()
    .from(projectRepos)
    .where(and(eq(projectRepos.projectId, args.projectId), eq(projectRepos.name, args.repo)))
    .get();
  if (!repoRow) {
    throw new Error(`no repo named "${args.repo}" in project "${args.projectId}"`);
  }
  const credentials = db().select().from(gitCredentials).all();
  const resolved = resolveCredential(repoRow.url, credentials, GIT_HOSTS);
  if (!resolved) {
    throw new Error(
      `no git credential matches the remote host of ${repoRow.url} — seed one and retry`,
    );
  }
  return resolved.host.createPR(resolved.credential, {
    remoteUrl: repoRow.url,
    head: args.head,
    base: args.base,
    title: args.title,
    body: args.body,
  });
}
