import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { MachineRunView } from "@/components/machines/run-view";
import { db } from "@/db";
import { getRun, listStageRuns, MachineError } from "@/db/machines";
import { sandboxForMachineRun } from "@/db/sandbox-view";
import { projects } from "@/db/schema";

export const dynamic = "force-dynamic";

/** Live view of one machine run (0009) — one shape for every run. */
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
  return (
    <MachineRunView
      initialRun={run}
      initialVisits={listStageRuns(db(), runId)}
      projectName={project?.name ?? null}
      sandbox={sandboxForMachineRun(db(), runId)}
    />
  );
}
