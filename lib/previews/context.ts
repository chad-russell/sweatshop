import { db } from "@/db";
import { getPreviewSetupDefinition } from "@/db/preview-setups";
import type { Preview } from "@/db/previews";
import { getProjectRepo } from "@/db/projects";
import { getLease, getLeaseProjectId } from "@/db/sandboxes";
import { sandboxWorkRoot } from "@/lib/sandboxes/provision";
import type { SandboxHandle } from "@/lib/sandboxes/provider";
import type { PreviewSetupDefinition } from "@/lib/previews/setup";

/**
 * What the branch-preview create flow (branch.ts) and the follower
 * (follow.ts) share: the create-failure marker, the sandbox shell
 * helper, and the ONE resolver for a preview row's project, setup and
 * repo root (service.ts and the routes use it too).
 */

/** Marker failedSha for a preview that never got as far as a commit. */
export const CREATE_FAILED = "create";

export async function sh(
  handle: SandboxHandle,
  command: string,
  cwd: string,
  env?: Record<string, string>,
): Promise<{ ok: boolean; out: string }> {
  const r = await handle.run(command, env ?? { GIT_TERMINAL_PROMPT: "0" }, cwd);
  return { ok: r.exitCode === 0, out: `${r.stdout}${r.stderr}`.trim() };
}

export function lastLine(text: string): string {
  return text.split("\n").pop()?.trim() ?? "";
}

/**
 * The project a preview belongs to (whose setup applies): branch
 * previews through their repo, worktree previews through their
 * sandbox's owner (conversation or machine run).
 */
export function previewProjectId(p: Preview): string | null {
  const repo = p.repoId ? getProjectRepo(db(), p.repoId) : null;
  if (repo) return repo.projectId;
  const lease = getLease(db(), p.sandboxId);
  return lease ? getLeaseProjectId(db(), lease) : null;
}

/** Everything a preview's lifecycle needs to know about where it runs. */
export interface PreviewContext {
  projectId: string | null;
  /** The project's saved setup, if any. */
  setup: PreviewSetupDefinition | null;
  /** The checkout the setup runs against inside the sandbox: a branch
   *  preview's repo, or (worktree previews) the setup's repo under the
   *  binding's work root. Null when it cannot be determined. */
  repoRoot: string | null;
}

export function resolvePreviewContext(p: Preview): PreviewContext {
  const projectId = previewProjectId(p);
  const setup = getPreviewSetupDefinition(db(), projectId);
  const lease = getLease(db(), p.sandboxId);
  const repo = p.repoId ? getProjectRepo(db(), p.repoId) : setup ? getProjectRepo(db(), setup.repo) : null;
  const repoRoot = lease && repo ? `${sandboxWorkRoot(lease.ownerId)}/${repo.name}` : null;
  return { projectId, setup, repoRoot };
}
