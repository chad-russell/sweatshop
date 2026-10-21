import { db } from "@/db";
import { getConversation } from "@/db/chat";
import { deriveSkillTitle } from "@/lib/skill-files";
import { readSkill } from "@/lib/skills";
import { renderOwnerPlaceholders } from "@/lib/agent/owner";
import {
  findPhase,
  isModeSkill,
  parseModeSkill,
  renderPhaseHandoff,
  type ModePhase,
  type ParsedModeSkill,
} from "@/lib/agent/mode-ids";

/**
 * 0055 v7 part B: resolve the phase handoff for a harness call or
 * start_thread child started FROM `conversationId` (docs/0055, "Who
 * reads what" / "Phase handoff"). The db-touching half of the
 * mechanism — `lib/agent/mode-ids.ts` stays pure; this is where the
 * conversation's mode state and skill body get read.
 *
 * `explicitPhase` is the tool's optional `phase` arg: given, it OVERRIDES
 * the chat's current phase and must resolve or the call refuses
 * (not-moded / unknown-phase, value-shaped for the model). Absent, the
 * chat's own `mode_phase` is used only if it is still a phase the
 * skill's CURRENT body declares — a stale id, "" (phaseless), a
 * legacy/no-phase thread, or a non-mode/no skill all mean "no handoff"
 * silently (`wrap` is the identity, `phaseName` is null), same as a
 * plain chat.
 */
export type PhaseHandoffResolution =
  | { ok: true; phaseName: string | null; wrap: (task: string) => string }
  | { ok: false; code: "not-moded" | "unknown-phase"; message: string };

export async function resolvePhaseHandoff(
  conversationId: string,
  explicitPhase?: string,
): Promise<PhaseHandoffResolution> {
  const conv = getConversation(db(), conversationId);
  const skill = conv?.skill ? await readSkill(conv.skill) : null;
  const isMode = isModeSkill(skill?.mode);

  if (explicitPhase !== undefined) {
    if (!isMode || !skill) {
      return { ok: false, code: "not-moded", message: "phase only applies in a moded chat — this chat is not in a mode" };
    }
    const parsed = parseModeSkill(skill.body);
    const target = findPhase(parsed.phases, explicitPhase);
    if (!target) {
      return {
        ok: false,
        code: "unknown-phase",
        message: `no such phase "${explicitPhase}" — declared phases: ${parsed.phases.map((p) => p.name).join(", ") || "none"}`,
      };
    }
    return { ok: true, phaseName: target.name, wrap: (task) => handoffText(skill, parsed, target, task) };
  }

  if (!isMode || !skill || !conv?.modePhase) return identity();
  const parsed = parseModeSkill(skill.body);
  const current = findPhase(parsed.phases, conv.modePhase);
  if (!current) return identity();
  return { ok: true, phaseName: current.name, wrap: (task) => handoffText(skill, parsed, current, task) };
}

function identity(): PhaseHandoffResolution {
  return { ok: true, phaseName: null, wrap: (task) => task };
}

function handoffText(
  skill: { id: string; body: string },
  parsed: ParsedModeSkill,
  phase: ModePhase,
  task: string,
): string {
  const modeName = deriveSkillTitle(skill.body, skill.id);
  return renderOwnerPlaceholders(renderPhaseHandoff({ modeName, phase, shared: parsed.shared, task }));
}
