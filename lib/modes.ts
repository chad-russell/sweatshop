import type { Db } from "../db";
import { planState } from "../db/plans";
import {
  checkEnterMode,
  extractIntro,
  extractPhaseSection,
  formatPhaseInstructions,
  isModeSkill,
  isTicketPhase,
  nextPhaseLabel,
  THREAD_STATE_PREFIX,
  threadStateNote,
  TICKET_PHASES,
  TICKET_SKILL_ID,
  validateTransition,
  type TicketPhase,
  type TransitionResult,
} from "./agent/mode-ids";

/**
 * 0055: ticket mode as code — the single place to import this from. The
 * pure core (ids, phase order, the transition rule, note text, section
 * extraction) lives in `lib/agent/mode-ids.ts` so workflow-body files
 * can use it without pulling in a db import; this module adds the ONE
 * piece that needs one — the plan-approval gate — and re-exports the
 * rest so every other caller has one door.
 */
export {
  checkEnterMode,
  extractIntro,
  extractPhaseSection,
  formatPhaseInstructions,
  isModeSkill,
  isTicketPhase,
  nextPhaseLabel,
  THREAD_STATE_PREFIX,
  threadStateNote,
  TICKET_PHASES,
  TICKET_SKILL_ID,
  validateTransition,
  type TicketPhase,
  type TransitionResult,
};

/** The one gate (0055): entering `implement` needs the conversation's
 *  latest plan approved — `db/plans.ts`'s durable sqlite fact, not a
 *  transcript read. Every other phase is ungated. */
export function checkPhaseGate(db: Db, conversationId: string, to: TicketPhase): TransitionResult {
  if (to !== "implement") return { ok: true };
  if (planState(db, conversationId).kind === "approved") return { ok: true };
  return { ok: false, code: "unapproved-plan", message: "implement needs an approved plan — present_plan first" };
}

/** The combined check `advance_phase` runs: shape, transition, gate. */
export function checkAdvance(db: Db, conversationId: string, from: TicketPhase, to: string, note?: string): TransitionResult {
  if (!isTicketPhase(to)) return { ok: false, code: "invalid-phase", message: `unknown phase "${to}"` };
  const transition = validateTransition(from, to, note);
  if (!transition.ok) return transition;
  return checkPhaseGate(db, conversationId, to);
}
