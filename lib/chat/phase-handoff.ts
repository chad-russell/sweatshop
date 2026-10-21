import { db } from "@/db";
import { getConversation, listModelMessages } from "@/db/chat";
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
import { deriveStatus, lastLoadedModeId } from "@/lib/status";

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
 * current phase is the active top-level status step when that label
 * matches a declared phase of the loaded mode skill. `mode_phase` is
 * only the fallback for a legacy thread whose status does not name a
 * phase. A phaseless, stale, or non-mode chat means "no handoff"
 * (`wrap` is the identity, `phaseName` is null).
 *
 * `skillId` / `skillVersion` / `phaseId` are what a harness call stores
 * so its card can re-render this exact handoff later.
 */
export type PhaseHandoffResolution =
  | {
      ok: true;
      phaseName: string | null;
      phaseId: string | null;
      skillId: string | null;
      skillVersion: number | null;
      wrap: (task: string) => string;
    }
  | { ok: false; code: "not-moded" | "unknown-phase"; message: string };

export async function resolvePhaseHandoff(
  conversationId: string,
  explicitPhase?: string,
): Promise<PhaseHandoffResolution> {
  const conv = getConversation(db(), conversationId);
  const messages = listModelMessages(db(), conversationId);
  // The column is what owner entry and use_skill of a mode write (a
  // newer mode wins). The transcript is the fallback when a mode was
  // loaded without that write.
  const columnSkill = conv?.skill ? await readSkill(conv.skill) : null;
  let skill = isModeSkill(columnSkill?.mode) ? columnSkill : null;
  if (!skill) {
    const loadedId = lastLoadedModeId(messages);
    const loaded = loadedId ? await readSkill(loadedId) : null;
    if (isModeSkill(loaded?.mode)) skill = loaded;
  }
  const isMode = skill != null;

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
    return resolved(skill, parsed, target);
  }

  if (!isMode || !skill) return identity();
  const parsed = parseModeSkill(skill.body);
  const active = deriveStatus(messages).current?.steps.find((step) => step.state === "active");
  const fromStatus = active ? findPhase(parsed.phases, active.label) : null;
  if (fromStatus) return resolved(skill, parsed, fromStatus);
  if (conv?.modePhase) {
    const legacy = findPhase(parsed.phases, conv.modePhase);
    if (legacy) return resolved(skill, parsed, legacy);
  }
  return identity();
}

function identity(): PhaseHandoffResolution {
  return { ok: true, phaseName: null, phaseId: null, skillId: null, skillVersion: null, wrap: (task) => task };
}

function resolved(
  skill: { id: string; body: string; version: number },
  parsed: ParsedModeSkill,
  phase: ModePhase,
): PhaseHandoffResolution {
  return {
    ok: true,
    phaseName: phase.name,
    phaseId: phase.id,
    skillId: skill.id,
    skillVersion: skill.version,
    wrap: (task) => handoffText(skill, parsed, phase, task),
  };
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
