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

/** 0023: project facts a stage brief carries (fetched where the run
 * starts — plain, serializable data). */
export interface ProjectFacts {
  testCommand: string | null;
  branchPrefix: string | null;
  /** 2026-10-09 friction: preview readiness, so stages plan facts —
   *  a saved setup means serving is one start_preview call. */
  preview: { command: string; port: number; services: string[] } | null;
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
  /** 0023: the project's work defaults (test command, branch prefix) —
   * plain data fetched where the run starts; null = no project. */
  project?: ProjectFacts | null;
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
  if (input.project) {
    const lines = [
      input.project.testCommand
        ? `- Test command (run from a repo root, must exit 0): \`${input.project.testCommand}\``
        : "- Test command: not set — when a stage must verify work, run the repo's own test script and say which you ran",
    ];
    if (input.project.branchPrefix) {
      lines.push(
        `- Branch prefix: \`${input.project.branchPrefix}/\` — name machine branches \`<prefix>/<slug>\``,
      );
    }
    lines.push(
      input.project.preview
        ? `- Preview setup: saved — \`start_preview\` serves it with no bootstrap (command \`${input.project.preview.command}\`, port ${input.project.preview.port}` +
          (input.project.preview.services.length > 0 ? `, services: ${input.project.preview.services.join(", ")}` : "") +
          ")"
        : "- Preview setup: none saved — the first stage needing visual QA bootstraps one (get_preview_setup / save_preview_setup); never hand-build a QA environment",
    );
    parts.push(`# Project\n\n${lines.join("\n")}`);
  }
  // 0013: agent stages also work in the run's sandbox (bash/pi/claude).
  if (input.workspaceRoot && (stage.kind === "harness" || stage.kind === "agent")) {
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
