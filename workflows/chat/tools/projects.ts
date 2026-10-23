/**
 * 0033 B project tools: list/create/edit/delete; create and delete approval-gated.
 */

import { tool } from "ai";
import { z } from "zod";
import { chatApprovalHook } from "../hooks";
import { ownerName } from "../../../lib/agent/owner";
import { createProjectPreviewStep, createProjectStep, deleteProjectPreviewStep, deleteProjectStep, editProjectStep, listProjectsStep, pendingStep } from "../steps";

export function projectTools(
  conversationId: string,
) {
  return {
    // 0033 Phase B: project tools — the setup chat's real powers. UI
    // and tools share the store cores (0015). Create and delete are
    // approval-gated (durable entities / destructive cascade).
    list_projects: tool({
      description:
        "List every project: id, name, repos, and work defaults (test command, branch prefix). " +
        "Read-only. A project chat already knows its own project from its instructions — use this " +
        "for setup/controller chats or cross-project work, or before creating or editing a project.",
      inputSchema: z.object({}),
      execute: () => listProjectsStep(),
    }),

    create_project: tool({
      description:
        "Create a project — the sweatshop unit of work (repos + settings its chats inherit). " +
        "Find repos first with gh/forgejo. Optionally set the test command, branch prefix, and a " +
        "default route ({provider, model}) at creation; everything else is editable later. " +
        `${ownerName()} is asked first — the turn waits for their answer. After creating, hand them the ` +
        "/?project=<id> link for the real project chat (this chat is a controller, never the project chat).",
      inputSchema: z.object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).describe("Lowercase kebab id, e.g. \"gpl\""),
        name: z.string().min(1).max(120),
        description: z.string().max(500).optional(),
        repos: z
          .array(z.object({ name: z.string().min(1).max(80), url: z.string().url() }))
          .max(10)
          .optional()
          .describe("Repos to track: {name: clone directory, url: http(s) remote}"),
        testCommand: z.string().max(500).optional().describe("The project's done-gate (run from a repo root, must exit 0)"),
        branchPrefix: z.string().max(60).optional(),
        defaultRoute: z.object({ provider: z.string(), model: z.string() }).optional(),
      }),
      // Approval-gated like create_machine: validate first (invalid
      // input returns to the model without asking), then Chad decides.
      execute: async (input, { toolCallId }) => {
        const preview = (await createProjectPreviewStep(input)) as
          | { ok: true; summary: string }
          | { ok: false; code: string; message: string };
        if (!preview.ok) return preview;
        await pendingStep(conversationId, toolCallId, preview.summary, "approval");
        const answer = await chatApprovalHook.create({ token: toolCallId });
        if (!(answer.kind === "approval" && answer.approved)) {
          return { ok: false, code: "denied" as const, message: `${ownerName()} declined — nothing was created` };
        }
        return createProjectStep(input);
      },
    }),

    edit_project: tool({
      description:
        "Change a project: rename, work defaults (testCommand/branchPrefix), sandbox image, model " +
        "settings (defaultRoute {provider, model}, allowedProviders, allowedHarnesses — null clears), " +
        "reposToAdd / reposToRemove (removal is guarded: blockers come back as issues). Partial by " +
        "design — valid fields apply, refusals are reported. Read the project first with list_projects.",
      inputSchema: z.object({
        id: z.string().min(1),
        name: z.string().min(1).max(120).optional(),
        testCommand: z.string().max(500).nullable().optional(),
        branchPrefix: z.string().max(60).nullable().optional(),
        imageRef: z.string().nullable().optional(),
        defaultRoute: z.object({ provider: z.string(), model: z.string() }).nullable().optional(),
        allowedProviders: z.array(z.string()).nullable().optional(),
        allowedHarnesses: z.array(z.string()).nullable().optional(),
        reposToAdd: z.array(z.object({ name: z.string().min(1).max(80), url: z.string().url() })).max(10).optional(),
        reposToRemove: z.array(z.string().min(1)).max(10).optional(),
      }),
      execute: (input) => editProjectStep(input),
    }),

    delete_project: tool({
      description:
        "Delete a project and everything it owns: live runs cancelled, sandboxes destroyed, " +
        "conversations/previews/folders deleted (credentials untouched — this cannot " +
        `be undone). ${ownerName()} is asked first with the full cascade summary; the turn waits for their answer.`,
      inputSchema: z.object({
        id: z.string().min(1),
      }),
      execute: async ({ id }, { toolCallId }) => {
        const preview = (await deleteProjectPreviewStep(id)) as
          | { ok: true; summary: string }
          | { ok: false; code: string; message: string };
        if (!preview.ok) return preview;
        await pendingStep(conversationId, toolCallId, preview.summary, "approval");
        const answer = await chatApprovalHook.create({ token: toolCallId });
        if (!(answer.kind === "approval" && answer.approved)) {
          return { ok: false, code: "denied" as const, message: `${ownerName()} declined — nothing was deleted` };
        }
        return deleteProjectStep(id);
      },
    }),
  };
}
