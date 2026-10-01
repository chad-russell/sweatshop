import { and, eq } from "drizzle-orm";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { db } from "../../db";
import { gitCredentials, projectRepos, projects } from "../../db/schema";
import { GIT_HOSTS } from "../../lib/git-hosts/hosts";
import { resolveCredential } from "../../lib/git-hosts/index";
import { sessionProjectId } from "../../lib/session-attributes";

/**
 * 0004 Phase D: open a pull request on one of the bound project's repos.
 * Thin by design — all logic lives in the GitHost implementation; this
 * tool only resolves project → repo → host-scoped credential.
 */
export default defineTool({
  description:
    "Open a pull request for a branch of one of this project's repos " +
    "(github or forgejo). Push the branch first (git push in the sandbox).",
  inputSchema: z.object({
    repo: z.string().describe("Repo directory name under /workspace"),
    head: z.string().describe("Branch containing the work"),
    base: z.string().optional().describe("Target branch (default: main)"),
    title: z.string().min(1),
    body: z.string().optional(),
  }),
  async execute({ repo, head, base, title, body }, ctx) {
    const projectId = sessionProjectId(ctx.session);
    if (!projectId) {
      throw new Error("no project bound to this conversation");
    }

    const project = db()
      .query.projects.findFirst({ where: eq(projects.id, projectId) })
      .sync();
    if (!project) throw new Error(`unknown project: ${projectId}`);

    const repoRow = db()
      .query.projectRepos.findFirst({
        where: and(
          eq(projectRepos.projectId, projectId),
          eq(projectRepos.name, repo),
        ),
      })
      .sync();
    if (!repoRow) {
      throw new Error(`no repo named "${repo}" in project "${projectId}"`);
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
      head,
      base,
      title,
      body,
    });
  },
});
