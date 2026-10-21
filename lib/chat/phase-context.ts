import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { skillVersions } from "@/db/schema";
import { deriveSkillTitle } from "@/lib/skill-files";
import { renderOwnerPlaceholders } from "@/lib/agent/owner";
import { findPhase, parseModeSkill, PHASE_HANDOFF_TASK_MARKER, renderPhaseHandoff } from "@/lib/agent/mode-ids";

/**
 * 0059: re-render the phase handoff a harness call was started with,
 * from the skill version stored on the call. Null when that version
 * or phase is gone.
 */
export function renderPhaseContext(
  db: Db,
  input: { skillId: string; skillVersion: number; phaseId: string; task: string },
): { phase: string; text: string } | null {
  const row = db
    .select({ body: skillVersions.body })
    .from(skillVersions)
    .where(and(eq(skillVersions.skillId, input.skillId), eq(skillVersions.version, input.skillVersion)))
    .get();
  if (!row) return null;
  const parsed = parseModeSkill(row.body);
  const phase = findPhase(parsed.phases, input.phaseId);
  if (!phase) return null;
  const rendered = renderOwnerPlaceholders(
    renderPhaseHandoff({ modeName: deriveSkillTitle(row.body, input.skillId), phase, shared: parsed.shared, task: input.task }),
  );
  const taskAt = rendered.indexOf(PHASE_HANDOFF_TASK_MARKER);
  return {
    phase: phase.name,
    // The card already quotes the orchestrator's task. This block is the
    // phase framing, Shared, and this phase only.
    text: (taskAt < 0 ? rendered : rendered.slice(0, taskAt)).trim(),
  };
}
