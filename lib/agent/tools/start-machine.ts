import { db } from "@/db";
import { listMachines } from "@/db/machines";
import { startRun } from "@/lib/machines/runs";
import { getConversation } from "@/db/chat";
import { getConversationBinding, type BoundSandbox } from "@/db/sandboxes";
import { inheritBinding, openConversationSandbox } from "@/lib/sandboxes/binding";
import type { SandboxProvider } from "@/lib/sandboxes/provider";

/**
 * 0010 Phase 3: the start_machine tool's core (port of agent/tools/
 * start_machine.ts, 0009). In a project conversation, project machines
 * run against THIS project; in Chats, only workspace-free machines are
 * offered. The run is its own workflow; 0013: a project run inherits
 * this conversation's sandbox binding (same sandbox, same directory —
 * binding the chat first if it was still pending) unless `fresh` asks
 * for a new sandbox of its own. The tool returns the run's URL.
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
  /** 0013: give the run its own new sandbox instead of this chat's. */
  fresh?: boolean;
  /** 0021: route overrides for the run. */
  overrides?: unknown;
  provider?: SandboxProvider;
  /** Test seam: the run starter (default lib/machines/runs startRun). */
  start?: typeof startRun;
}): Promise<{ runId: string; url: string; sandbox: "inherited" | "own" | "none" }> {
  const { machines } = listAvailableMachines(input.conversationId);
  if (!machines.some((m) => m.id === input.machineId)) {
    const projectId = getConversation(db(), input.conversationId)?.projectId ?? null;
    throw new Error(
      `machine "${input.machineId}" is not available here (${projectId ? "project" : "no-workspace"} machines: ` +
        `${machines.map((m) => m.id).join(", ") || "none"})`,
    );
  }
  const projectId = getConversation(db(), input.conversationId)?.projectId ?? null;
  // Project machines inherit the chat's sandbox by default (workspace-
  // free ones have nothing to inherit into).
  let inherit: BoundSandbox | undefined;
  if (projectId && !input.fresh) {
    const binding = getConversationBinding(db(), input.conversationId);
    if (binding && binding.kind !== "none") {
      const { binding: bound } = await openConversationSandbox(input.conversationId, input.provider);
      inherit = inheritBinding(bound);
    }
  }
  const run = await (input.start ?? startRun)({
    machineId: input.machineId,
    prompt: input.prompt,
    projectId,
    parentConversationId: input.conversationId,
    ...(inherit ? { inherit } : {}),
    ...(input.overrides ? { overrides: input.overrides } : {}),
  });
  return {
    runId: run.id,
    url: `/r/${run.id}`,
    sandbox: inherit ? "inherited" : projectId ? "own" : "none",
  };
}
