import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { gitCredentials, projectRepos } from "@/db/schema";
import { GIT_HOSTS } from "./hosts";
import { resolveCredential } from "./index";

/**
 * 0004 Phase D core, shared by the create_pr tool and machine harness
 * stages (0009): resolve project → repo → host-scoped credential, then
 * open the PR through the GitHost seam. 0034 Phase A: the resolution is
 * extracted so the approval preview validates the same way without
 * POSTing.
 */
export type ProjectRepoResolution =
  | { ok: true; repoUrl: string; host: import("./index").GitHost; credential: import("@/db/schema").GitCredential }
  | { ok: false; code: "no-repo" | "no-credential"; message: string };

/** Resolve a project repo name to its remote URL, host, and credential. */
export function resolveProjectRepo(projectId: string, repo: string): ProjectRepoResolution {
  const repoRow = db()
    .select()
    .from(projectRepos)
    .where(and(eq(projectRepos.projectId, projectId), eq(projectRepos.name, repo)))
    .get();
  if (!repoRow) {
    return {
      ok: false,
      code: "no-repo",
      message: `no repo named "${repo}" in project "${projectId}"`,
    };
  }
  const credentials = db().select().from(gitCredentials).all();
  const resolved = resolveCredential(repoRow.url, credentials, GIT_HOSTS);
  if (!resolved) {
    return {
      ok: false,
      code: "no-credential",
      message: `no git credential matches the remote host of ${repoRow.url} — seed one and retry`,
    };
  }
  return { ok: true, repoUrl: repoRow.url, host: resolved.host, credential: resolved.credential };
}

export async function openProjectPR(args: {
  projectId: string;
  repo: string;
  head: string;
  base?: string;
  title: string;
  body?: string;
}) {
  const resolved = resolveProjectRepo(args.projectId, args.repo);
  if (!resolved.ok) throw new Error(resolved.message);
  return resolved.host.createPR(resolved.credential, {
    remoteUrl: resolved.repoUrl,
    head: args.head,
    base: args.base,
    title: args.title,
    body: args.body,
  });
}
