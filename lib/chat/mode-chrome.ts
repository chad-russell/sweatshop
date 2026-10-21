import { db } from "@/db";
import { getConversation } from "@/db/chat";
import { deriveSkillTitle } from "@/lib/skill-files";
import { readSkill } from "@/lib/skills";
import { findPhase, isModeSkill, parseModeSkill } from "@/lib/agent/mode-ids";
import type { ModeChromeData } from "@/lib/read-models/mode-chrome";

/**
 * 0055 PR2: the Mode chip's data — null for a plain chat with no skill
 * bound at all. A skill bound but not (or no longer) a mode reports
 * `{kind: "bound"}`. Otherwise parses the mode skill's CURRENT body
 * live so the declared-phase fallback never drifts from the skill the
 * agent loaded. The stepper itself comes from the derived status.
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
