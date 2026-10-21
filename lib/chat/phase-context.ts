import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { skillVersions } from "@/db/schema";
import { deriveSkillTitle } from "@/lib/skill-files";
import { renderOwnerPlaceholders } from "@/lib/agent/owner";
import { findPhase, parseModeSkill, renderPhaseHandoff } from "@/lib/agent/mode-ids";

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
  return {
    phase: phase.name,
    text: renderOwnerPlaceholders(
      renderPhaseHandoff({ modeName: deriveSkillTitle(row.body, input.skillId), phase, shared: parsed.shared, task: input.task }),
    ),
  };
}
