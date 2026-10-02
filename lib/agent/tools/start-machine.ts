import { db } from "@/db";
import { listMachines } from "@/db/machines";
import { startRun } from "@/lib/machines/runs";
import { getConversation } from "@/db/chat";

/**
 * 0010 Phase 3: the start_machine tool's core (port of agent/tools/
 * start_machine.ts, 0009). In a project conversation, project machines
 * run against THIS project; in Chats, only workspace-free machines are
 * offered. The run is independent of this conversation (its own
 * workflow, its own sandbox) — the tool returns the run's URL.
 *
 * Plain function: the workflow step wraps it; the run starts in-process
 * through lib/machines/runs (0012) — no SWEATSHOP_APP_ORIGIN round trip
 * (0010 deletes that class of HTTP hop).
 */

export interface MachineListing {
  machines: { id: string; name: string; description: string | null }[];
  note: string;
}

export function listAvailableMachines(conversationId: string): MachineListing {
  const projectId = getConversation(db(), conversationId)?.projectId ?? null;
  const wanted = projectId ? "project" : "none";
  const available = listMachines(db()).filter(
    (m) => m.definition.workspace === wanted,
  );
  return {
    machines: available.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
    })),
    note: projectId
      ? `project machines run against project ${projectId}`
      : "workspace-free machines (project machines start from a project conversation)",
  };
}

export async function startMachineRun(input: {
  conversationId: string;
  machineId: string;
  prompt: string;
}): Promise<{ runId: string; url: string }> {
  const { machines } = listAvailableMachines(input.conversationId);
  if (!machines.some((m) => m.id === input.machineId)) {
    const projectId = getConversation(db(), input.conversationId)?.projectId ?? null;
    throw new Error(
      `machine "${input.machineId}" is not available here (${projectId ? "project" : "no-workspace"} machines: ` +
        `${machines.map((m) => m.id).join(", ") || "none"})`,
    );
  }
  const projectId = getConversation(db(), input.conversationId)?.projectId ?? null;
  const run = await startRun({
    machineId: input.machineId,
    prompt: input.prompt,
    projectId,
  });
  return { runId: run.id, url: `/r/${run.id}` };
}
