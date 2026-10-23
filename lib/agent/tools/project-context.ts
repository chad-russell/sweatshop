import { db } from "@/db";
import { getConversation } from "@/db/chat";
import { getProject, listProjectRepos } from "@/db/projects";
import type { ProjectContext } from "@/workflows/chat/instructions";

/**
 * The project a conversation is bound to, shaped for the top-level
 * agent's instructions (workflows/chat/instructions.ts's
 * buildProjectSection): project chats never named their own project to
 * the model, so it would call list_projects to find "the relevant
 * project" instead of just using the one it is already in. Null when
 * the conversation has no project, or the project was since deleted.
 */
export function loadProjectContext(conversationId: string): ProjectContext | null {
  const conn = db();
  const projectId = getConversation(conn, conversationId)?.projectId;
  if (!projectId) return null;
  const project = getProject(conn, projectId);
  if (!project) return null;
  return {
    id: project.id,
    name: project.name,
    description: project.description ?? null,
    repos: listProjectRepos(conn, projectId).map((r) => ({ name: r.name, url: r.url })),
    testCommand: project.testCommand ?? null,
    branchPrefix: project.branchPrefix ?? null,
  };
}
