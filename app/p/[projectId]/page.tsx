import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { ChatSurface } from "@/components/chat";
import { db } from "@/db";
import { projects } from "@/db/schema";

/**
 * Start a conversation in a project (0004 Phase C): the page validates
 * the project against the store; the chat surface sends
 * x-sweatshop-project on session creation, binding the session (and its
 * sandbox) to this project.
 */
export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const project = db()
    .query.projects.findFirst({ where: eq(projects.id, projectId) })
    .sync();

  if (!project) notFound();

  return <ChatSurface projectId={project.id} projectName={project.name} />;
}
