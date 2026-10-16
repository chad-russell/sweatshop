import { db } from "@/db";
import { getConversation } from "@/db/chat";
import { listProjectRepos } from "@/db/projects";
import { getConversationBinding } from "@/db/sandboxes";
import { readCappedFile, type RepoDoc } from "@/lib/agent/repo-docs";
import { openSandbox } from "@/lib/sandboxes/binding";
import type { SandboxProvider } from "@/lib/sandboxes/provider";

/**
 * Repo AGENTS.md for the top-level agent's instructions appendix
 * (workflows/chat/instructions.ts): live testing showed pi, claude,
 * cursor, and the top-level agent itself never read a project repo's
 * AGENTS.md on their own, so this reads it in for the agent at the start
 * of a turn. Only when the conversation has a project AND its sandbox is
 * already BOUND — never provisions one just to read these files (a
 * pending or missing binding returns []); a missing AGENTS.md drops that
 * repo silently, never an error.
 *
 * Plain function on purpose, like runBash: the workflow step
 * (loadRepoDocsStep) is a thin wrapper, and tests inject a fake provider
 * here (step args must serialize, so the provider can never ride through
 * the workflow boundary).
 */
export async function loadRepoDocs(
  conversationId: string,
  provider?: SandboxProvider,
): Promise<RepoDoc[]> {
  const projectId = getConversation(db(), conversationId)?.projectId;
  if (!projectId) return [];
  const binding = getConversationBinding(db(), conversationId);
  if (binding?.kind !== "bound") return [];
  const repos = listProjectRepos(db(), projectId);
  if (repos.length === 0) return [];
  const { handle, workDir } = await openSandbox(binding, provider);
  const docs: RepoDoc[] = [];
  for (const repo of repos) {
    const path = `${workDir.replace(/\/+$/, "")}/${repo.name}/AGENTS.md`;
    const content = await readCappedFile(handle, path);
    if (content != null) docs.push({ repo: repo.name, path, content });
  }
  return docs;
}
