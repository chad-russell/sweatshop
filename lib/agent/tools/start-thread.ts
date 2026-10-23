import { randomUUID } from "node:crypto";
import { db } from "@/db";
import {
  ensureConversation,
  getConversation,
  setConversationParent,
  setConversationSkill,
  setConversationWorkStep,
  listModelMessages,
} from "@/db/chat";
import { disableConversationSandbox, getConversationBinding } from "@/db/sandboxes";
import { attachConversation, openConversationSandbox } from "@/lib/sandboxes/binding";
import type { SandboxProvider } from "@/lib/sandboxes/provider";
import { listThreadSkills } from "@/lib/skills";
import { deriveOutline, prependOutlineHandoff, runnerGate } from "@/lib/outline";

/**
 * 0037 phase 3: the start_thread tool's core — a fresh child chat with
 * deliberately independent context (fresh eyes for a review), started
 * from this thread and attached to its sandbox by default (0013: same
 * sandbox, same directory — the child reads the same checkout) unless
 * `fresh` gives it one of its own. The child records its parent and
 * wakes it when it settles (lib/chat/wake.ts, the 0022 primitive);
 * `cancel_run` covers it. The child's first turn IS the prompt — the
 * parent passes raw material (ticket, branch, evidence), never its
 * reasoning.
 *
 * Plain function: the workflow step wraps it. The turn starter is a
 * seam (default: a dynamic import — a static one would close the
 * turn → tools → steps → core → start-turn cycle), so tests never
 * touch the workflow runtime or podman.
 */

export type StartThreadResult =
  | {
      ok: true;
      /** The child chat's conversation id (c_…) — inspect/cancel/status. */
      id: string;
      url: string;
      runId: string;
      sandbox: "attached" | "own" | "none";
      skill: string | null;
      note: string;
    }
  | {
      ok: false;
      code: "no-skill" | "start-failed" | "runner-refused";
      message: string;
    };

export async function startThread(
  input: {
    conversationId: string;
    prompt: string;
    skill?: string;
    fresh?: boolean;
    provider?: SandboxProvider;
    /** Test seam: the child's turn starter (default startChatTurn). */
    start?: (conversationId: string, text: string) => Promise<{ runId: string }>;
  },
): Promise<StartThreadResult> {
  // 0054: binding a NEW child can only pick an ACTIVE thread skill —
  // readSkill would also resolve a disabled/deleted one (by design,
  // for a thread that's already running it), which is wrong here.
  if (input.skill && !(await listThreadSkills()).some((s) => s.id === input.skill)) {
    return {
      ok: false,
      code: "no-skill",
      message: `no thread skill "${input.skill}" — use_skill lists what exists`,
    };
  }
  const parent = getConversation(db(), input.conversationId);
  if (!parent) {
    return { ok: false, code: "start-failed", message: `no conversation ${input.conversationId}` };
  }
  const outline = deriveOutline(listModelMessages(db(), input.conversationId)).current?.outline ?? null;
  const gate = runnerGate(outline, { kind: "thread" });
  if (!gate.ok) return { ok: false, code: "runner-refused", message: gate.message };
  const childId = `c_t${Date.now().toString(36)}${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  ensureConversation(db(), childId, parent.projectId);
  if (input.skill) setConversationSkill(db(), childId, input.skill);
  if (gate.active) setConversationWorkStep(db(), childId, gate.active.label);

  // The sandbox choice mirrors start_machine: attached to the parent's
  // binding by default (binding the parent first if it was still
  // pending), its own when `fresh`, none only when the parent has none.
  let sandbox: "attached" | "own" | "none" = "own";
  if (!input.fresh) {
    const binding = getConversationBinding(db(), input.conversationId);
    if (binding?.kind === "none") {
      disableConversationSandbox(db(), childId);
      sandbox = "none";
    } else if (binding) {
      const { binding: bound } = await openConversationSandbox(input.conversationId, input.provider);
      await attachConversation(childId, bound.sandboxId, input.provider, parent.projectId);
      sandbox = "attached";
    }
  }

  setConversationParent(db(), childId, input.conversationId);
  try {
    const start =
      input.start ??
      (async (id: string, text: string) => {
        const { startChatTurn } = await import("@/lib/chat/start-turn");
        return startChatTurn(id, text);
      });
    const { runId } = await start(childId, prependOutlineHandoff(input.prompt, outline).task);
    return {
      ok: true,
      id: childId,
      url: `/c/${childId}`,
      runId,
      sandbox,
      skill: input.skill ?? null,
      note:
        `the child thread runs in the background — this conversation is woken with its ` +
        `final message when it settles (inspect ${childId}; cancel_run stops it)`,
    };
  } catch (err) {
    return {
      ok: false,
      code: "start-failed",
      message: `the child thread was created but its turn failed to start: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}
