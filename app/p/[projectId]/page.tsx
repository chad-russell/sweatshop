import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { ChatSurface } from "@/components/chat";
import { StartRunButton } from "@/components/machines/start-run-button";
import { RunTicketButton } from "@/components/run-ticket-button";
import { db } from "@/db";
import { projects } from "@/db/schema";

/**
 * Start a conversation in a project (0004 Phase C): the page validates
 * the project against the store; the chat surface sends
 * x-sweatshop-project on session creation, binding the session (and its
 * sandbox) to this project. The machine button starts a project machine
 * run bound here (0009); the arrow button is the legacy run_ticket
 * pipeline (0004 Path B, retired by the 0009 port).
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

  return (
    <ChatSurface
      projectId={project.id}
      projectName={project.name}
      headerExtra={
        <>
          <StartRunButton projectId={project.id} />
          <RunTicketButton projectId={project.id} />
        </>
      }
    />
  );
}
