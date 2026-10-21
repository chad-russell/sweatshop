import { db } from "@/db";
import { getConversation, setConversationMode, setConversationPhase } from "@/db/chat";
import { getTarget } from "@/db/prompt-settings";
import { readSkill } from "@/lib/skills";
import { renderOwnerPlaceholders } from "@/lib/agent/owner";
import {
  checkEnterMode,
  checkLegacyAdopt,
  findPhase,
  isModeSkill,
  parseModeSkill,
  renderModeEntry,
  renderPhaseSection,
  validateTransition,
} from "@/lib/agent/mode-ids";

/**
 * 0055 v7: mode tools' cores — `enter_mode`'s preview/apply and
 * `advance_phase`. `mode` is any skill id now (owner-defined, freely);
 * these cores validate it exists, is flagged as a mode, and is active.
 * Plain functions; the workflow steps are thin wrappers (same split as
 * lib/agent/tools/plan.ts).
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
  const conv = getConversation(db(), conversationId);
  if (!conv) return fail("not-found", "conversation not found");
  if (!conv.projectId) return fail("no-project", "modes need a project");
  const target = getTarget(db(), { kind: "skill", id: input.mode });
  if (!target || target.status === "deleted" || !isModeSkill(target.mode)) {
    return fail("unknown-mode", `no mode "${input.mode}"`);
  }
  if (target.status === "disabled") return fail("mode-disabled", `the "${input.mode}" mode is disabled`);
  const check = checkEnterMode({ skill: conv.skill, modePhase: conv.modePhase });
  if (!check.ok) return fail("already-moded", check.message);
  return { ok: true, summary: `Enter "${input.mode}" mode for "${input.ticket}"? ${input.reason}` };
}

export interface ApplyEnterModeResult {
  ok: true;
  mode: string;
  /** The first declared phase's id, or "" when the mode has none. */
  phase: string;
  /** brief + phase list + Shared + the first phase's section, owner-rendered. */
  runbook: string;
  ticket: string;
}

/** Approved: write skill + phase (the first declared phase, or "" for a
 *  phaseless mode), hand back the entry content. */
export async function applyEnterMode(conversationId: string, modeId: string, ticket: string): Promise<ApplyEnterModeResult | Fail> {
  const skill = await readSkill(modeId);
  if (!skill) return fail("no-skill", `the "${modeId}" mode is unavailable`);
  const parsed = parseModeSkill(skill.body);
  const phase = parsed.phases[0]?.id ?? "";
  setConversationMode(db(), conversationId, modeId, phase);
  return { ok: true, mode: modeId, phase, runbook: renderOwnerPlaceholders(renderModeEntry(parsed)), ticket };
}

export interface AdvancePhaseResult {
  ok: true;
  /** Null when this call ADOPTED a legacy (or then-phaseless) thread —
   *  no prior phase to move from. */
  from: string | null;
  to: string;
  instructions: string;
}

/** advance_phase: no approval — the owner already approved the plan
 *  (a human gate in the skill's own markdown, 0041's card), not each
 *  phase move. `to` must be a phase THIS skill's CURRENT body declares
 *  (by id or case-insensitive name); the very next one in document
 *  order needs no note, anything else does. A legacy thread (mode
 *  skill bound, no phase recorded yet) or one that entered a
 *  then-phaseless mode adopts any declared phase, note required. */
export async function advancePhase(conversationId: string, to: string, note?: string): Promise<AdvancePhaseResult | Fail> {
  const conv = getConversation(db(), conversationId);
  if (!conv) return fail("not-found", "conversation not found");
  if (!conv.skill) return fail("not-moded", "this chat is not in a mode — enter_mode first");
  const skill = await readSkill(conv.skill);
  if (!skill || !isModeSkill(skill.mode)) return fail("not-moded", "this chat is not in a mode — enter_mode first");
  const parsed = parseModeSkill(skill.body);
  if (parsed.phases.length === 0) return fail("no-phases", "this mode has no phases");
  const fromId = conv.modePhase && conv.modePhase !== "" ? conv.modePhase : null;
  const check = fromId ? validateTransition(parsed.phases, fromId, to, note) : checkLegacyAdopt(parsed.phases, to, note);
  if (!check.ok) return fail(check.code ?? "invalid", check.message ?? "cannot advance");
  const target = findPhase(parsed.phases, to)!; // guaranteed found by the checks above
  setConversationPhase(db(), conversationId, target.id);
  return { ok: true, from: fromId, to: target.id, instructions: renderOwnerPlaceholders(renderPhaseSection(target)) };
}
