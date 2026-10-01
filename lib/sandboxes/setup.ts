import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  gitCredentials,
  projectRepos,
  projects,
  type GitCredential,
  type Project,
  type ProjectRepo,
} from "@/db/schema";
import type { SandboxShell } from "@/lib/sandbox-shell";
import { GIT_HOSTS } from "@/lib/git-hosts/hosts";
import { httpsRemote, resolveCredential } from "@/lib/git-hosts/index";

/**
 * Shared project-workspace provisioning (0004): given anything with a
 * shell (`run`), stamp git identity, install host-scoped credentials,
 * and clone the project's repos into /workspace/<repo>. Consumed by the
 * eve sandbox selector (Path A) and by directly provisioned containers
 * (Path B) so both see identical workspaces.
 */

const GIT_USER_NAME = process.env.GIT_USER_NAME ?? "sweatshop agent";
const GIT_USER_EMAIL = process.env.GIT_USER_EMAIL ?? "agent@sweatshop.local";

export interface ProjectPlan {
  project: Project;
  repos: ProjectRepo[];
  credentials: GitCredential[];
}

export function loadProjectPlan(projectId: string): ProjectPlan | null {
  const project = db()
    .query.projects.findFirst({ where: eq(projects.id, projectId) })
    .sync();
  if (!project) return null;
  const repos = db()
    .select()
    .from(projectRepos)
    .where(eq(projectRepos.projectId, project.id))
    .all();
  const credentials = db().select().from(gitCredentials).all();
  return { project, repos, credentials };
}

async function runChecked(
  sandbox: SandboxShell,
  command: string,
  context: string,
) {
  const result = await sandbox.run(command);
  if (result.exitCode !== 0) {
    throw new Error(
      `${context} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

/** See module doc. Throws with context-rich messages on failure. */
export async function setupProjectWorkspace(
  sandbox: SandboxShell,
  projectId: string,
): Promise<ProjectPlan> {
  const plan = loadProjectPlan(projectId);
  if (!plan) {
    throw new Error(
      `project "${projectId}" does not exist in the sweatshop store`,
    );
  }

  await runChecked(
    sandbox,
    `git config --global user.name ${JSON.stringify(GIT_USER_NAME)} && ` +
      `git config --global user.email ${JSON.stringify(GIT_USER_EMAIL)}`,
    "git identity",
  );

  const installed = new Set<string>();
  for (const repo of plan.repos) {
    const resolved = resolveCredential(repo.url, plan.credentials, GIT_HOSTS);
    if (resolved && !installed.has(resolved.credential.id)) {
      await resolved.host.installAuth(sandbox, resolved.credential);
      installed.add(resolved.credential.id);
    }
  }

  for (const repo of plan.repos) {
    await runChecked(
      sandbox,
      `[ -d /workspace/${repo.name} ] || ` +
        `GIT_TERMINAL_PROMPT=0 git clone -- ${httpsRemote(repo.url)} /workspace/${repo.name}`,
      `cloning ${repo.name} (${repo.url})`,
    );
  }

  return plan;
}
