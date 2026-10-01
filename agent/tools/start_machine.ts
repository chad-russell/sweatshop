import { defineTool } from "eve/tools";
import { z } from "zod";
import { db } from "../../db";
import { listMachines } from "../../db/machines";
import { sessionProjectId } from "../../lib/session-attributes";

/**
 * 0009: start a machine run from a conversation. In a project
 * conversation, project machines run against THIS project; in Chats,
 * only workspace-free machines are offered. The run is independent of
 * this conversation (its own workflow, its own sandbox) — the tool
 * returns the run's URL to hand to Chad. Starts go through the Next
 * route (the workflow world lives in that process).
 */
export default defineTool({
  description:
    "Start a machine run (a multi-stage pipeline: coding harnesses, eve " +
    "conversations, and Chad's approval gates) and return its URL. Call " +
    "with no machineId to list the machines available here.",
  inputSchema: z.object({
    machineId: z.string().optional().describe("Machine id; omit to list machines"),
    prompt: z.string().optional().describe("The task the run works on (required to start)"),
  }),
  async execute({ machineId, prompt }, ctx) {
    const projectId = sessionProjectId(ctx.session);
    const wanted = projectId ? "project" : "none";
    const available = listMachines(db()).filter((m) => m.definition.workspace === wanted);
    if (!machineId) {
      return {
        machines: available.map((m) => ({ id: m.id, name: m.name, description: m.description })),
        note: projectId
          ? `project machines run against project ${projectId}`
          : "workspace-free machines (project machines start from a project conversation)",
      };
    }
    if (!available.some((m) => m.id === machineId)) {
      throw new Error(
        `machine "${machineId}" is not available here (${wanted === "project" ? "project" : "no-workspace"} machines: ` +
          `${available.map((m) => m.id).join(", ") || "none"})`,
      );
    }
    if (!prompt?.trim()) throw new Error("prompt is required to start a run");
    const origin = process.env.SWEATSHOP_APP_ORIGIN ?? "http://127.0.0.1:3000";
    const res = await fetch(`${origin}/api/machine-runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId, prompt, ...(projectId ? { projectId } : {}) }),
    });
    const body = (await res.json().catch(() => ({}))) as { run?: { id: string }; error?: string };
    if (!res.ok || !body.run) throw new Error(body.error ?? `start failed (HTTP ${res.status})`);
    return { runId: body.run.id, url: `/r/${body.run.id}` };
  },
});
