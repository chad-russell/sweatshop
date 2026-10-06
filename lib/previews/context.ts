import { eq } from "drizzle-orm";
import { db } from "@/db";
import { getPreviewSetupDefinition } from "@/db/preview-setups";
import type { Preview } from "@/db/previews";
import { getLease } from "@/db/sandboxes";
import { projectRepos } from "@/db/schema";
import { sandboxWorkRoot } from "@/lib/sandboxes/provision";
import type { SandboxHandle } from "@/lib/sandboxes/provider";
import type { PreviewSetupDefinition } from "@/lib/previews/setup";

/**
 * What the branch-preview create flow (branch.ts) and the follower
 * (follow.ts) share: the create-failure marker, the sandbox shell
 * helper, and the repo/project/setup context derived from a preview row.
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

/** Repo + project context derived from a preview row (confirm/follow). */
export interface PreviewContext {
  projectId: string;
  repoRoot: string;
}

export function previewContext(p: Preview): PreviewContext | null {
  if (!p.repoId) return null;
  const repo = db().select().from(projectRepos).where(eq(projectRepos.id, p.repoId)).get();
  const lease = getLease(db(), p.sandboxId);
  if (!repo || !lease) return null;
  return { projectId: repo.projectId, repoRoot: `${sandboxWorkRoot(lease.ownerId)}/${repo.name}` };
}

/** The project's saved setup for a preview's repo, if any. */
export function setupFor(p: Preview): PreviewSetupDefinition | null {
  const ctx = previewContext(p);
  return ctx ? getPreviewSetupDefinition(db(), ctx.projectId) : null;
}
