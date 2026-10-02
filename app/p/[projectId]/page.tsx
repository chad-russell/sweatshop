import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { ChatSurface } from "@/components/chat";
import { db } from "@/db";
import { projects } from "@/db/schema";

/**
 * Start a conversation in a project (0004 Phase C): the page validates
 * the project against the store; the chat surface sends
 * x-sweatshop-project on session creation, binding the session (and its
 * sandbox) to this project. The composer's target picker (0012;
 * `?machine=<id>` preselects) starts a project machine run bound here.
 */
export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ machine?: string }>;
}) {
  const { projectId } = await params;
  const { machine } = await searchParams;
  const project = db()
    .query.projects.findFirst({ where: eq(projects.id, projectId) })
    .sync();

  if (!project) notFound();

  return (
    <ChatSurface
      key={machine ?? "chat"}
      projectId={project.id}
      projectName={project.name}
      initialMachineId={machine ?? null}
    />
  );
}
