import type { Db } from "@/db";
import { appendMessages, getConversation, setConversationMode } from "@/db/chat";
import { getTarget } from "@/db/prompt-settings";
import { renderOwnerPlaceholders } from "@/lib/agent/owner";
import { isModeSkill, parseModeSkill, renderModeEntry } from "@/lib/agent/mode-ids";
import { readSkill } from "@/lib/skills";

/**
 * 0055 v7 owner entry: `?mode=<id>` (and the legacy `?skill=<id>`, which
 * means the same thing when that skill is actually a mode) on a send.
 * The owner's own action needs no self-approval: this writes the mode
 * directly (a newer mode simply replaces whatever skill was bound),
 * then appends a `runEvent: "mode"` row carrying the rendered entry
 * content (brief + phase list + Shared + first phase + status seed).
 * The caller
 * (the chat send route) does this BEFORE starting the turn for the
 * owner's actual message, so that row is already history by the time
 * the turn loads it — never the system prompt, never re-injected.
 */

export type EnterModeResult = { ok: true } | { ok: false; code: string; message: string };

/**
 * The part of entry validation that needs no conversation row at all —
 * exists, is a mode, is active. Exported so the send route can run it
 * BEFORE `ensureConversation` for a fresh send: a refused mode must
 * leave no orphan conversation row.
 */
export function validateModeTarget(db: Db, modeId: string): { ok: true } | { ok: false; code: string; message: string } {
  const target = getTarget(db, { kind: "skill", id: modeId });
  if (!target || target.status === "deleted" || !isModeSkill(target.mode)) {
    return { ok: false, code: "unknown-mode", message: `no mode "${modeId}"` };
  }
  if (target.status === "disabled") {
    return { ok: false, code: "mode-disabled", message: `the "${modeId}" mode is disabled` };
  }
  return { ok: true };
}

export async function enterModeOnSend(db: Db, conversationId: string, modeId: string, projectId: string | null): Promise<EnterModeResult> {
  if (!projectId) return { ok: false, code: "no-project", message: "modes need a project" };
  if (!getConversation(db, conversationId)) return { ok: false, code: "not-found", message: "conversation not found" };
  const target = validateModeTarget(db, modeId);
  if (!target.ok) return target;
  const skill = await readSkill(modeId);
  if (!skill) return { ok: false, code: "no-skill", message: `the "${modeId}" mode is unavailable` };

  const parsed = parseModeSkill(skill.body);
  const phase = parsed.phases[0]?.id ?? "";
  setConversationMode(db, conversationId, modeId, phase);
  const rendered = renderOwnerPlaceholders(renderModeEntry(parsed));
  appendMessages(db, conversationId, [
    {
      id: `mode_${conversationId}_${Date.now()}`,
      role: "user",
      text: rendered,
      modelMessage: { role: "user", content: rendered },
      metadata: { runEvent: { kind: "mode", id: modeId, status: "entered" } },
    },
  ]);
  return { ok: true };
}
