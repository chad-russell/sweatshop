import type { Db } from "@/db";
import { appendMessages, getConversation, setConversationMode } from "@/db/chat";
import { getTarget } from "@/db/prompt-settings";
import { renderOwnerPlaceholders } from "@/lib/agent/owner";
import { checkEnterMode, isModeSkill, parseModeSkill, renderModeEntry } from "@/lib/agent/mode-ids";
import { readSkill } from "@/lib/skills";

/**
 * 0055 v7 owner entry: `?mode=<id>` (and the legacy `?skill=<id>`, which
 * means the same thing when that skill is actually a mode) on a send.
 * Unlike `enter_mode` — the agent's tool, gated on the owner's approval
 * — the owner's own action needs no self-approval: this writes the mode
 * directly, then appends a `runEvent: "mode"` row carrying the rendered
 * entry content (brief + phase list + Shared + first phase). The caller
 * (the chat send route) does this BEFORE starting the turn for the
 * owner's actual message, so that row is already history by the time
 * the turn loads it — never the system prompt, never re-injected.
 */

export type EnterModeResult = { ok: true } | { ok: false; code: string; message: string };

export async function enterModeOnSend(db: Db, conversationId: string, modeId: string, projectId: string | null): Promise<EnterModeResult> {
  if (!projectId) return { ok: false, code: "no-project", message: "modes need a project" };
  const conversation = getConversation(db, conversationId);
  const check = checkEnterMode({ skill: conversation?.skill ?? null, modePhase: conversation?.modePhase ?? null });
  if (!check.ok) return { ok: false, code: "already-moded", message: check.message };
  const target = getTarget(db, { kind: "skill", id: modeId });
  if (!target || target.status === "deleted" || !isModeSkill(target.mode)) {
    return { ok: false, code: "unknown-mode", message: `no mode "${modeId}"` };
  }
  if (target.status === "disabled") {
    return { ok: false, code: "mode-disabled", message: `the "${modeId}" mode is disabled` };
  }
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
