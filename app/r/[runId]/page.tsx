import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { MachineRunView } from "@/components/machines/run-view";
import { db } from "@/db";
import { getRun, listStageRuns, MachineError } from "@/db/machines";
import { folderPath } from "@/db/organize";
import { sandboxForMachineRun } from "@/db/sandbox-view";
import { conversations, folders, projects } from "@/db/schema";

export const dynamic = "force-dynamic";

/**
 * Live view of one machine run (0009) — one shape for every run. 0012:
 * the run is a conversation, so the header is its breadcrumb (group ›
 * folders › title) with the same rename / move / archive the sidebar
 * row offers.
 */
export default async function MachineRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  let run;
  try {
    run = getRun(db(), runId);
  } catch (err) {
    if (err instanceof MachineError && err.code === "not-found") notFound();
    throw err;
  }
  const project = run.projectId
    ? db().select({ name: projects.name }).from(projects).where(eq(projects.id, run.projectId)).get()
    : undefined;
  const conversation = db()
    .select({ title: conversations.title, folderId: conversations.folderId, archivedAt: conversations.archivedAt })
    .from(conversations)
    .where(eq(conversations.id, runId))
    .get();
  const groupFolders = db()
    .select()
    .from(folders)
    .all()
    .filter((f) => f.projectId === run.projectId);
  const index = new Map(groupFolders.map((f) => [f.id, f]));
  return (
    <MachineRunView
      initialRun={run}
      initialVisits={listStageRuns(db(), runId)}
      projectName={project?.name ?? null}
      sandbox={sandboxForMachineRun(db(), runId)}
      conversation={{
        title: conversation?.title ?? null,
        folderId: conversation?.folderId ?? null,
        path: folderPath(index, conversation?.folderId ?? null),
        archived: Boolean(conversation?.archivedAt),
        folderChoices: groupFolders
          .map((f) => ({ id: f.id, name: folderPath(index, f.id).join(" / "), depth: 0 }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      }}
    />
  );
}
