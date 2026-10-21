import { db } from "@/db";
import { getConversation, setConversationMode, setConversationPhase } from "@/db/chat";
import { readSkill } from "@/lib/skills";
import { renderOwnerPlaceholders } from "@/lib/agent/owner";
import {
  checkAdvance,
  checkEnterMode,
  checkLegacyAdopt,
  formatPhaseInstructions,
  isModeSkill,
  isTicketPhase,
  TICKET_SKILL_ID,
  type TicketPhase,
} from "@/lib/modes";

/**
 * 0055: ticket mode's tool cores — `enter_mode`'s preview/apply and
 * `advance_phase`. Plain functions; the workflow steps are thin
 * wrappers (same split as lib/agent/tools/plan.ts).
 */

type Fail = { ok: false; code: string; message: string };
const fail = (code: string, message: string): Fail => ({ ok: false, code, message });

export interface EnterModeInput {
  mode: string;
  ticket: string;
  reason: string;
}

/** enter_mode's preview: validates without writing anything — the
 *  write happens only after the owner approves (applyEnterMode). */
export function enterModePreview(conversationId: string, input: EnterModeInput): { ok: true; summary: string } | Fail {
  if (input.mode !== TICKET_SKILL_ID) {
    return fail("unknown-mode", `no mode "${input.mode}" — only "${TICKET_SKILL_ID}" exists`);
  }
  const conv = getConversation(db(), conversationId);
  if (!conv) return fail("not-found", "conversation not found");
  if (!conv.projectId) return fail("no-project", "ticket mode needs a project");
  const check = checkEnterMode({ skill: conv.skill, modePhase: conv.modePhase });
  if (!check.ok) return fail("already-moded", check.message);
  return { ok: true, summary: `Enter ticket mode for "${input.ticket}"? ${input.reason}` };
}

/** Approved: write skill + phase (plan), hand back the plan phase's
 *  own runbook text (intro + `## plan`), owner-rendered. */
export async function applyEnterMode(
  conversationId: string,
  ticket: string,
): Promise<{ ok: true; mode: string; phase: TicketPhase; runbook: string; ticket: string } | Fail> {
  const skill = await readSkill(TICKET_SKILL_ID);
  if (!skill) return fail("no-skill", "the ticket skill is unavailable");
  const runbook = formatPhaseInstructions(skill.body, "plan");
  if (runbook == null) return fail("bad-runbook", 'the ticket skill has no "plan" section');
  setConversationMode(db(), conversationId, TICKET_SKILL_ID, "plan");
  return { ok: true, mode: TICKET_SKILL_ID, phase: "plan", runbook: renderOwnerPlaceholders(runbook), ticket };
}

export interface AdvancePhaseResult {
  ok: true;
  /** Null when this call ADOPTED a legacy ticket-skill thread (no prior
   *  phase to move from). */
  from: TicketPhase | null;
  to: TicketPhase;
  instructions: string;
}

/** advance_phase: not approval-gated — the owner already approved the
 *  plan, not each phase move; lib/modes.ts's pure rules plus the one
 *  (implement) gate are the whole check. A legacy thread (skill=ticket,
 *  no phase yet) has no "from" to validate a transition against —
 *  `checkLegacyAdopt` adopts it into `to` directly instead (note
 *  required, same plan gate for anything past "plan"). */
export async function advancePhase(conversationId: string, to: string, note?: string): Promise<AdvancePhaseResult | Fail> {
  const conv = getConversation(db(), conversationId);
  if (!conv) return fail("not-found", "conversation not found");
  if (!isModeSkill(conv.skill)) {
    return fail("not-moded", "this chat is not in ticket mode — enter_mode first");
  }
  const from = isTicketPhase(conv.modePhase) ? conv.modePhase : null;
  const check = from
    ? checkAdvance(db(), conversationId, from, to, note)
    : checkLegacyAdopt(db(), conversationId, to, note);
  if (!check.ok) return fail(check.code ?? "invalid", check.message ?? "cannot advance");
  const skill = await readSkill(TICKET_SKILL_ID);
  if (!skill) return fail("no-skill", "the ticket skill is unavailable");
  const toPhase = to as TicketPhase; // checkAdvance/checkLegacyAdopt both validated this above
  const instructions = formatPhaseInstructions(skill.body, toPhase);
  if (instructions == null) return fail("bad-runbook", `the ticket skill has no "${to}" section`);
  setConversationPhase(db(), conversationId, toPhase);
  return { ok: true, from, to: toPhase, instructions: renderOwnerPlaceholders(instructions) };
}
