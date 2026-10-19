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
import { REPO_DOC_TOTAL_CAP, capRepoDoc, readCappedFile } from "@/lib/agent/repo-docs";

/**
 * Shared project-workspace provisioning (0004): given anything with a
 * shell (`run`), stamp git identity, install host-scoped credentials,
 * and clone the project's repos into <root>/<repo>. Consumed by the
 * sandbox provider (lease provisioning), so every sandbox sees an
 * identical workspace.
 *
 * It also writes `<root>/AGENTS.md` and `<root>/CLAUDE.md` (identical
 * content): the harnesses (pi/claude/cursor/codex) start with cwd at the work
 * root, not inside a repo, and live testing showed none of them load a
 * repo's own AGENTS.md unprompted — this file points them at it.
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
  /** Directory the repos clone into (0009: machine runs use a per-run root). */
  root = "/workspace",
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
      `mkdir -p ${root} && [ -d ${root}/${repo.name} ] || ` +
        `GIT_TERMINAL_PROMPT=0 git clone -- ${httpsRemote(repo.url)} ${root}/${repo.name}`,
      `cloning ${repo.name} (${repo.url})`,
    );
  }

  const repoDocs: WorkRootRepo[] = [];
  for (const repo of plan.repos) {
    const agentsMd = await readCappedFile(sandbox, `${root}/${repo.name}/AGENTS.md`);
    repoDocs.push({ name: repo.name, agentsMd });
  }
  await writeWorkRootDoc(sandbox, root, buildWorkRootDoc(root, repoDocs));

  return plan;
}

export interface WorkRootRepo {
  name: string;
  /** The repo's AGENTS.md content (capped), or null when it has none. */
  agentsMd: string | null;
}

/**
 * The work-root AGENTS.md / CLAUDE.md content: a short header (this is a
 * sweatshop work root, repos are subdirectories, read each repo's
 * AGENTS.md before working in it, repo changes go only inside the repo
 * checkouts), the repo list, then each repo's AGENTS.md inlined (capped;
 * a pointer to the full file when cut). Pure, so it is unit tested
 * without a sandbox.
 */
export function buildWorkRootDoc(root: string, repos: readonly WorkRootRepo[]): string {
  const header = [
    "# sweatshop work root",
    "",
    "This is a sweatshop work root: the repos below are checked out as its",
    "subdirectories. Read each repo's AGENTS.md before working in it, and",
    "follow it. Repo changes are made only inside the repo checkouts below —",
    "never in this root.",
    "",
    "Repos:",
    ...repos.map((r) => `- ${r.name}: ${root}/${r.name}`),
  ].join("\n");
  // Same total budget as the chat agent appendix: a repo that would
  // push past it is listed with a cat pointer instead of inlined.
  const sections: string[] = [];
  const omitted: string[] = [];
  let total = 0;
  for (const r of repos) {
    if (r.agentsMd == null) continue;
    const path = `${root}/${r.name}/AGENTS.md`;
    const section = `# ${r.name} AGENTS.md (${path})\n\n${capRepoDoc(r.agentsMd, path)}`;
    if (sections.length > 0 && total + section.length > REPO_DOC_TOTAL_CAP) {
      omitted.push(path);
      continue;
    }
    sections.push(section);
    total += section.length;
  }
  if (omitted.length > 0) {
    sections.push(
      `# More repo instructions\n\nNot inlined (size budget). Read before working in those repos: ${omitted
        .map((x) => `cat ${x}`)
        .join("; ")}.`,
    );
  }
  return [header, ...sections].join("\n\n");
}

/** Overwrite <root>/AGENTS.md and <root>/CLAUDE.md with the same content
 *  (idempotent; base64-piped so the content's own quoting never matters).
 *  Never touches a repo checkout — both files live beside them. */
async function writeWorkRootDoc(sandbox: SandboxShell, root: string, content: string): Promise<void> {
  const encoded = Buffer.from(content, "utf8").toString("base64");
  await runChecked(
    sandbox,
    `mkdir -p ${root} && printf %s '${encoded}' | base64 -d > ${root}/AGENTS.md && cp ${root}/AGENTS.md ${root}/CLAUDE.md`,
    "writing the work-root AGENTS.md/CLAUDE.md",
  );
}
