/**
 * 0055: ticket mode's pure core — ids, phase order, the transition rule,
 * the per-turn note text, and `##`-section extraction. Deliberately
 * dependency-free (no db import) so workflow-body files
 * (workflows/chat/instructions.ts, workflows/chat/turn.ts — both must
 * stay free of db imports, even transitively, same as
 * lib/usage/pricing.ts) can import it directly. `lib/modes.ts` adds the
 * one db-touching piece (the plan-approval gate) and re-exports
 * everything here — that is the module everything else should import
 * from; this one exists only to keep those two files pure.
 */

export const TICKET_SKILL_ID = "ticket";

/** Is this skill id a MODE (sticky, phased) rather than an ordinary
 *  thread skill? Only "ticket" today — one mode, hardcoded, rather than
 *  a registry nothing else would use yet (0056 is where a second mode,
 *  if any, earns one). */
export function isModeSkill(skillId: string | null | undefined): boolean {
  return skillId === TICKET_SKILL_ID;
}

export const TICKET_PHASES = ["plan", "implement", "review", "fixup", "ship"] as const;
export type TicketPhase = (typeof TICKET_PHASES)[number];

export function isTicketPhase(value: string | null | undefined): value is TicketPhase {
  return value != null && (TICKET_PHASES as readonly string[]).includes(value);
}

const phaseIndex = (phase: TicketPhase): number => TICKET_PHASES.indexOf(phase);

/** The phase after `phase` in the fixed order, or "done" after the last
 *  one (ship) — the `[thread state]` note's "next:" field. */
export function nextPhaseLabel(phase: TicketPhase): TicketPhase | "done" {
  const i = phaseIndex(phase);
  return i + 1 < TICKET_PHASES.length ? TICKET_PHASES[i + 1]! : "done";
}

/** `[thread state] mode: ticket · phase: implement (2/5) · next: review` —
 *  the per-turn reminder (workflows/chat/turn.ts), rebuilt fresh every
 *  turn from the live column, never persisted. */
export const THREAD_STATE_PREFIX = "[thread state]";

export function threadStateNote(phase: TicketPhase): string {
  const position = phaseIndex(phase) + 1;
  return `${THREAD_STATE_PREFIX} mode: ticket · phase: ${phase} (${position}/${TICKET_PHASES.length}) · next: ${nextPhaseLabel(phase)}`;
}

export interface TransitionResult {
  ok: boolean;
  code?: "same-phase" | "needs-note" | "skip" | "unapproved-plan" | "invalid-phase";
  message?: string;
}

const ok: TransitionResult = { ok: true };

function refuse(code: NonNullable<TransitionResult["code"]>, message: string): TransitionResult {
  return { ok: false, code, message };
}

/**
 * Pure transition validity: forward exactly one step, review→ship (a
 * clean review skips fixup entirely), the fixup⇄review loop (either
 * direction, no note needed), or backward to any earlier phase with a
 * non-empty note explaining why. Same-phase is a no-op refusal. Does
 * not check the plan gate — that needs a db read, see `lib/modes.ts`'s
 * `checkPhaseGate`.
 */
export function validateTransition(from: TicketPhase, to: TicketPhase, note?: string): TransitionResult {
  if (to === from) return refuse("same-phase", `already in ${to}`);
  if ((from === "review" && to === "fixup") || (from === "fixup" && to === "review")) return ok;
  if (from === "review" && to === "ship") return ok;
  const diff = phaseIndex(to) - phaseIndex(from);
  if (diff === 1) return ok;
  if (diff < 0) {
    return note?.trim() ? ok : refuse("needs-note", `moving back to ${to} needs a note explaining why`);
  }
  return refuse("skip", `cannot skip from ${from} to ${to} — advance one phase at a time`);
}

/**
 * Refusals for entering ticket mode (shared by the `enter_mode` tool and
 * the owner-entry send path): already in it, or running a different
 * skill entirely — mode and skill binding don't mix.
 */
export function checkEnterMode(current: { skill: string | null; modePhase: string | null }): { ok: true } | { ok: false; message: string } {
  if (current.modePhase || isModeSkill(current.skill)) {
    return { ok: false, message: "already in ticket mode" };
  }
  if (current.skill) {
    return { ok: false, message: `already running the "${current.skill}" skill — binding is the owner's` };
  }
  return { ok: true };
}

/** Everything before the first `## ` heading, trimmed — the runbook's
 *  orchestrator intro, shown regardless of phase. */
export function extractIntro(markdown: string): string {
  const idx = markdown.search(/^##[ \t]/m);
  return (idx === -1 ? markdown : markdown.slice(0, idx)).trim();
}

/**
 * The body of the `## <phaseId>` section (heading excluded), matching
 * the phase id against the heading's first word, case-insensitively.
 * Null when no such heading exists. The next `## ` heading (of any
 * name) ends the section.
 */
export function extractPhaseSection(markdown: string, phaseId: string): string | null {
  const lines = markdown.split("\n");
  let found = false;
  const captured: string[] = [];
  for (const line of lines) {
    const heading = /^##[ \t]+(\S+)/.exec(line);
    if (heading) {
      if (found) break;
      found = heading[1]!.toLowerCase() === phaseId.toLowerCase();
      continue;
    }
    if (found) captured.push(line);
  }
  return found ? captured.join("\n").trim() : null;
}

/** The intro plus one phase's section, reassembled under its own
 *  heading — what `enter_mode`/`advance_phase` hand back to the model
 *  and what the owner-entry send writes into the transcript. Null when
 *  the runbook has no section for that phase (a malformed skill body). */
export function formatPhaseInstructions(markdown: string, phase: TicketPhase): string | null {
  const section = extractPhaseSection(markdown, phase);
  if (section == null) return null;
  const intro = extractIntro(markdown);
  return `${intro}\n\n## ${phase}\n\n${section}`.trim();
}
