import type { Db } from "@/db";
import { appendMessages, getConversation, setConversationMode } from "@/db/chat";
import { renderOwnerPlaceholders } from "@/lib/agent/owner";
import { checkEnterMode, formatPhaseInstructions, TICKET_SKILL_ID } from "@/lib/modes";
import { readSkill } from "@/lib/skills";

/**
 * 0055 owner entry: `?mode=ticket` (and the legacy `?skill=ticket`,
 * which means the same thing now that ticket is a mode) on a send.
 * Unlike `enter_mode` — the agent's tool, gated on the owner's approval
 * — the owner's own action needs no self-approval: this writes the mode
 * directly, then appends a `runEvent: "mode"` row carrying the rendered
 * plan-phase runbook. The caller (the chat send route) does this BEFORE
 * starting the turn for the owner's actual message, so that row is
 * already history by the time the turn loads it — never the system
 * prompt, never re-injected.
 */

export type EnterTicketModeResult = { ok: true } | { ok: false; code: string; message: string };

export async function enterTicketModeOnSend(
  db: Db,
  conversationId: string,
  projectId: string | null,
): Promise<EnterTicketModeResult> {
  if (!projectId) return { ok: false, code: "no-project", message: "ticket mode needs a project" };
  const conversation = getConversation(db, conversationId);
  const check = checkEnterMode({ skill: conversation?.skill ?? null, modePhase: conversation?.modePhase ?? null });
  if (!check.ok) return { ok: false, code: "already-moded", message: check.message };
  const skill = await readSkill(TICKET_SKILL_ID);
  if (!skill) return { ok: false, code: "no-skill", message: "the ticket skill is unavailable" };
  const runbook = formatPhaseInstructions(skill.body, "plan");
  if (runbook == null) return { ok: false, code: "bad-runbook", message: 'the ticket skill has no "plan" section' };

  setConversationMode(db, conversationId, TICKET_SKILL_ID, "plan");
  const rendered = renderOwnerPlaceholders(runbook);
  appendMessages(db, conversationId, [
    {
      id: `mode_${conversationId}_${Date.now()}`,
      role: "user",
      text: rendered,
      modelMessage: { role: "user", content: rendered },
      metadata: { runEvent: { kind: "mode", id: TICKET_SKILL_ID, status: "entered" } },
    },
  ]);
  return { ok: true };
}
