import {
  END,
  allowedTargets,
  type MachineDefinition,
  type Stage,
} from "./definition";

/**
 * 0009 stage briefs + transition resolution. Pure (the workflow body
 * imports it). A stage visit is a fresh conversation, so the brief
 * carries the thread: the run's prompt, earlier visits' outcomes, the
 * stage's instructions, and — when it branches — how to choose.
 */

export interface PriorVisit {
  stageId: string;
  title: string;
  outcome: string | null;
  transitionTo: string | null;
}

/** Outcome text kept per prior visit in a brief. */
export const OUTCOME_CLIP = 6000;

export function clipText(text: string | null | undefined, max: number): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}\n…[clipped ${text.length - max} chars]` : text;
}

export function buildBrief(input: {
  prompt: string;
  definition: MachineDefinition;
  stageId: string;
  history: PriorVisit[];
  /** Human feedback carried into this visit (e.g. a gate comment). */
  feedback?: string | null;
  /** Repo checkout root for harness stages (project workspaces). */
  workspaceRoot?: string | null;
}): string {
  const stage = input.definition.stages[input.stageId]!;
  const parts: string[] = [];
  parts.push(`# Task\n\n${input.prompt}`);
  if (input.history.length > 0) {
    parts.push(
      "# Earlier stages\n\n" +
        input.history
          .map(
            (v, i) =>
              `## ${i + 1}. ${v.title} (${v.stageId})` +
              (v.transitionTo ? ` → ${v.transitionTo}` : "") +
              `\n\n${clipText(v.outcome, OUTCOME_CLIP) || "(no output)"}`,
          )
          .join("\n\n"),
    );
  }
  if (input.feedback) parts.push(`# Feedback from Chad\n\n${input.feedback}`);
  if (input.workspaceRoot && stage.kind === "harness") {
    parts.push(
      `# Workspace\n\nThe project's git repos are cloned under \`${input.workspaceRoot}/<repo>\` ` +
        "(your working directory). Earlier stages worked in the same checkout.",
    );
  }
  parts.push(`# Your stage: ${stage.title}\n\n${stage.instructions}`);
  const guide = transitionGuide(stage);
  if (guide) parts.push(guide);
  return parts.join("\n\n");
}

/** How an agent stage ends — present only when it must choose. */
export function transitionGuide(stage: Stage): string | null {
  const targets = stage.next;
  if (targets.length < 2) return null;
  return (
    "# Finishing\n\nWhen your work for this stage is complete, call the `transition` " +
    "tool exactly once with one of these targets, then stop:\n\n" +
    targets.map((t) => `- \`${t.to}\`${t.when ? ` — ${t.when}` : ""}`).join("\n")
  );
}

/**
 * Resolve where a finished stage visit goes. Zero targets → END;
 * exactly one → it (no choice needed); several → the proposal, which
 * must be one of them. Returns null when a choice was required but
 * missing or invalid (the run parks for Chad).
 */
export function resolveTransition(stage: Stage, proposed: string | null): string | null {
  const targets = allowedTargets(stage);
  if (targets.length === 0) return END;
  if (targets.length === 1) return targets[0]!;
  return proposed && targets.includes(proposed) ? proposed : null;
}
