import { eq } from "drizzle-orm";
import { defineSandbox } from "eve/sandbox";
import { DockerSandbox } from "eve/sandbox/docker";
import { db } from "../db";
import {
  gitCredentials,
  projectRepos,
  projects,
  type Project,
  type ProjectRepo,
  type GitCredential,
} from "../db/schema";
import { forgejoHost } from "../lib/git-hosts/forgejo";
import { githubHost } from "../lib/git-hosts/github";
import { httpsRemote, resolveCredential } from "../lib/git-hosts/index";

/**
 * 0004 project sandbox (Phase C): every durable session opens its own
 * sibling container on host podman (Phase A) and gets the BOUND
 * project's repos cloned into /workspace/<repo> with host-scoped git
 * credentials installed. Binding comes from the session's initiating
 * principal (x-sweatshop-project → channel auth attributes), immutable
 * for the session's life.
 */
const HOSTS = [githubHost, forgejoHost];

const GIT_USER_NAME = process.env.GIT_USER_NAME ?? "sweatshop agent";
const GIT_USER_EMAIL = process.env.GIT_USER_EMAIL ?? "agent@sweatshop.local";

export const environment = DockerSandbox.environment({
  // Bake git into the prepared image if the base image lacks it (prepare
  // runs once per environment generation, not per session). image_ref on
  // sandbox_configs is schema-ready but unused in v1 (shared base image,
  // decision 2).
  prepare: async (sandbox) => {
    const check = await sandbox.run({ command: "command -v git" });
    if (check.exitCode === 0) return;
    const install = await sandbox.run({
      command:
        "apt-get update && apt-get install -y --no-install-recommends git",
    });
    if (install.exitCode !== 0) throw new Error(install.stderr);
  },
});

interface ProjectSandboxPlan {
  project: Project;
  repos: ProjectRepo[];
  credentials: GitCredential[];
  networkPolicy: "allow-all" | "deny-all";
}

function loadPlan(projectId: string): ProjectSandboxPlan | null {
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

  // v1 egress is coarse: any repo needing auth implies allow-all (clones
  // and pushes need egress). deny-all only when nothing needs the network.
  const networkPolicy = repos.length > 0 ? "allow-all" : "deny-all";
  return { project, repos, credentials, networkPolicy };
}

async function run(sandbox: Awaited<ReturnType<typeof environment.open>>, command: string, context: string) {
  const result = await sandbox.run({ command });
  if (result.exitCode !== 0) {
    // Bootstrap failures surface as the failure of every later tool
    // call, so they must carry their own context (Phase A gotcha).
    throw new Error(
      `${context} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

export default defineSandbox(async ({ session }) => {
  const attributes = session.auth.initiator?.attributes as
    | { project?: unknown }
    | undefined;
  const projectId =
    typeof attributes?.project === "string" ? attributes.project : null;

  // Decision 4: non-project conversations get no sandbox — the error must
  // be self-explanatory because it surfaces as the failure of whatever
  // tool call first touched the sandbox (Phase A gotcha).
  if (!projectId) {
    throw new Error(
      "no project bound to this conversation — bash/file tools are only available in project conversations (start one from a project page)",
    );
  }
  const plan = loadPlan(projectId);
  if (!plan) {
    throw new Error(
      `project "${projectId}" does not exist in the sweatshop store — fix the project id or re-seed`,
    );
  }

  const sandbox = await environment.open({ networkPolicy: plan.networkPolicy });

  await run(
    sandbox,
    `git config --global user.name ${JSON.stringify(GIT_USER_NAME)} && ` +
      `git config --global user.email ${JSON.stringify(GIT_USER_EMAIL)}`,
    "git identity",
  );

  // Install host-scoped credentials once each (dedup by credential id).
  const installed = new Set<string>();
  for (const repo of plan.repos) {
    const resolved = resolveCredential(repo.url, plan.credentials, HOSTS);
    if (resolved && !installed.has(resolved.credential.id)) {
      await resolved.host.installAuth(
        { run: (command) => sandbox.run({ command }) },
        resolved.credential,
      );
      installed.add(resolved.credential.id);
    }
  }

  for (const repo of plan.repos) {
    await run(
      sandbox,
      `[ -d /workspace/${repo.name} ] || ` +
        `GIT_TERMINAL_PROMPT=0 git clone -- ${httpsRemote(repo.url)} /workspace/${repo.name}`,
      `cloning ${repo.name} (${repo.url})`,
    );
  }

  return sandbox;
});
