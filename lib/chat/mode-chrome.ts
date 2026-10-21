import { db } from "@/db";
import { getConversation } from "@/db/chat";
import { deriveSkillTitle } from "@/lib/skill-files";
import { readSkill } from "@/lib/skills";
import { findPhase, isModeSkill, parseModeSkill } from "@/lib/agent/mode-ids";
import type { ModeChromeData } from "@/lib/read-models/mode-chrome";

/**
 * 0055 PR2: the Mode chip's data — null for a plain chat with no skill
 * bound at all. A skill bound but not (or no longer) a mode reports
 * `{kind: "bound"}` — `checkEnterMode` refuses a new mode on ANY thread
 * with a skill already bound, so the chip must say entering is blocked
 * instead of offering modes the server will always refuse. Otherwise
 * parses the mode skill's CURRENT body live (same source
 * `enter_mode`/`advance_phase` read) so the chip never drifts from what
 * the agent actually sees.
 */
export async function loadModeChrome(conversationId: string): Promise<ModeChromeData | null> {
  const conv = getConversation(db(), conversationId);
  if (!conv?.skill) return null;
  const skill = await readSkill(conv.skill);
  if (!skill || !isModeSkill(skill.mode)) return { kind: "bound", skillId: conv.skill };
  const parsed = parseModeSkill(skill.body);
  const current = conv.modePhase ? findPhase(parsed.phases, conv.modePhase) : null;
  return {
    kind: "mode",
    skillId: conv.skill,
    title: deriveSkillTitle(skill.body, skill.id),
    phases: parsed.phases.map((p) => ({ id: p.id, name: p.name })),
    current: current ? { id: current.id, name: current.name } : null,
  };
}
