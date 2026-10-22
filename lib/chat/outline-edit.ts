import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { appendMessages, getConversation, listModelMessages } from "@/db/chat";
import { approveOutlineRow, openOutlineReview, outlineState, type OutlineCard } from "@/db/outlines";
import {
  deriveOutline,
  isPendingRunnerEdit,
  renderOutlineEdit,
  validateOutline,
  type Outline,
} from "@/lib/outline";
import { getProjectModels } from "@/db/providers";
import { validationContext } from "@/lib/providers/resolve";
import { validateRoute } from "@/lib/providers/route";

export type EditOutlineResult =
  | { ok: true; version: number; rowId: string; approved: boolean; woke: boolean }
  | { ok: false; status: 400 | 404 | 409; code: string; error: string };

export interface EditOutlineDeps {
  wake: (conversationId: string, version: number, rowId: string, approved: boolean, note?: string) => Promise<unknown>;
}

function refuse(status: 400 | 404 | 409, code: string, error: string): EditOutlineResult {
  return { ok: false, status, code, error };
}

/** Owner edit: validate, append one user snapshot row, update review
 * state, and wake only when approved or when changing an approved
 * outline's pending runner. */
export async function editOutline(
  input: {
    conversationId: string;
    outline: unknown;
    baseVersion: unknown;
    approve?: boolean;
    note?: string;
  },
  deps: EditOutlineDeps,
): Promise<EditOutlineResult> {
  const conversation = getConversation(db(), input.conversationId);
  if (!conversation) return refuse(404, "not-found", "conversation not found");
  const parsed = validateOutline(input.outline as Record<string, unknown>);
  if ("ok" in parsed) return refuse(400, parsed.code, parsed.message);
  if (!Number.isInteger(input.baseVersion) || (input.baseVersion as number) < 1) {
    return refuse(400, "invalid-version", "baseVersion must be a positive integer");
  }

  const derived = deriveOutline(listModelMessages(db(), input.conversationId));
  if (!derived.current) return refuse(409, "no-outline", "there is no outline to edit");
  if (derived.current.version !== input.baseVersion) {
    return refuse(409, "stale", `outline v${derived.current.version} is current — reload before editing`);
  }

  const state = outlineState(db(), input.conversationId);
  if (state.kind === "approved" && !isPendingRunnerEdit(derived.current.outline, parsed)) {
    return refuse(409, "approved", "after approval, only pending top-level step runners may be changed");
  }
  if (state.kind !== "review" && input.approve) {
    return refuse(409, "not-in-review", "only an outline in review can be approved with an edit");
  }

  const project = getProjectModels(db(), conversation.projectId);
  const context = validationContext(db(), project);
  for (const step of parsed.steps) {
    if (!step.runner || typeof step.runner === "string") continue;
    const checked = validateRoute(step.runner, context);
    if (!checked.ok) {
      return refuse(400, "invalid-runner", `runner for "${step.label}" cannot run: ${checked.issues.join("; ")}`);
    }
  }

  const version = derived.current.version + 1;
  const rowId = `oe_${Date.now().toString(36)}${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const proposed = state.kind === "review";
  const snapshot = { version, outline: parsed as Outline, proposed };
  const text = renderOutlineEdit(snapshot);
  appendMessages(db(), input.conversationId, [{
    id: rowId,
    role: "user",
    text,
    modelMessage: { role: "user", content: text },
    metadata: { runEvent: { kind: "outline-edit", id: rowId, status: "edited" } },
  }]);

  if (proposed) {
    const card: OutlineCard = { kind: "outline", version, outline: parsed, ...(input.note ? { note: input.note } : {}) };
    openOutlineReview(db(), { id: rowId, conversationId: input.conversationId, card });
    if (input.approve) {
      if (!approveOutlineRow(db(), rowId, input.note)) return refuse(409, "stale", "the edited outline was answered already");
      await deps.wake(input.conversationId, version, rowId, true, input.note);
      return { ok: true, version, rowId, approved: true, woke: true };
    }
    return { ok: true, version, rowId, approved: false, woke: false };
  }

  await deps.wake(input.conversationId, version, rowId, false, input.note);
  return { ok: true, version, rowId, approved: false, woke: true };
}
