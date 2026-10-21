import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { db } from "../db";
import { ensureConversation } from "../db/chat";
import { approvePlanRow, openPlanReview } from "../db/plans";
import {
  checkAdvance,
  checkEnterMode,
  checkLegacyAdopt,
  checkPhaseGate,
  extractIntro,
  extractPhaseSection,
  formatPhaseInstructions,
  isModeSkill,
  isTicketPhase,
  nextPhaseLabel,
  threadStateNote,
  TICKET_PHASES,
  TICKET_SKILL_ID,
  validateTransition,
  type TicketPhase,
} from "../lib/modes";

let seq = 0;
function conv(): string {
  const id = `c_test_modes_${++seq}_${Math.random().toString(36).slice(2, 8)}`;
  ensureConversation(db(), id);
  return id;
}

describe("ids", () => {
  it("isModeSkill is true only for ticket", () => {
    expect(isModeSkill("ticket")).toBe(true);
    expect(isModeSkill("review")).toBe(false);
    expect(isModeSkill(null)).toBe(false);
    expect(isModeSkill(undefined)).toBe(false);
  });

  it("isTicketPhase recognizes exactly the five phases", () => {
    for (const p of TICKET_PHASES) expect(isTicketPhase(p)).toBe(true);
    expect(isTicketPhase("plans")).toBe(false);
    expect(isTicketPhase(null)).toBe(false);
  });

  it("TICKET_SKILL_ID is ticket", () => {
    expect(TICKET_SKILL_ID).toBe("ticket");
  });
});

describe("validateTransition", () => {
  it("forward one step needs no note", () => {
    expect(validateTransition("plan", "implement")).toMatchObject({ ok: true });
    expect(validateTransition("implement", "review")).toMatchObject({ ok: true });
    expect(validateTransition("fixup", "ship")).toMatchObject({ ok: true });
  });

  it("the fixup <-> review loop needs no note, either direction", () => {
    expect(validateTransition("review", "fixup")).toMatchObject({ ok: true });
    expect(validateTransition("fixup", "review")).toMatchObject({ ok: true });
  });

  it("review -> ship needs no note (a clean review skips fixup)", () => {
    expect(validateTransition("review", "ship")).toMatchObject({ ok: true });
  });

  it("still refuses other skips, even the same distance as review -> ship", () => {
    expect(validateTransition("plan", "review")).toMatchObject({ ok: false, code: "skip" });
    expect(validateTransition("implement", "ship")).toMatchObject({ ok: false, code: "skip" });
  });

  it("same-phase is a no-op refusal", () => {
    expect(validateTransition("plan", "plan")).toMatchObject({ ok: false, code: "same-phase" });
  });

  it("backward (beyond the fixup/review loop) needs a non-empty note", () => {
    expect(validateTransition("ship", "plan")).toMatchObject({ ok: false, code: "needs-note" });
    expect(validateTransition("ship", "plan", "   ")).toMatchObject({ ok: false, code: "needs-note" });
    expect(validateTransition("ship", "plan", "found a design flaw")).toMatchObject({ ok: true });
    expect(validateTransition("review", "implement")).toMatchObject({ ok: false, code: "needs-note" });
    expect(validateTransition("review", "implement", "scope grew")).toMatchObject({ ok: true });
  });

  it("forward skip (more than one step) is refused even with a note", () => {
    expect(validateTransition("plan", "review")).toMatchObject({ ok: false, code: "skip" });
    expect(validateTransition("plan", "review", "skip ahead")).toMatchObject({ ok: false, code: "skip" });
  });
});

describe("checkPhaseGate: the one gate — implement needs an approved plan", () => {
  it("refuses entering implement with no plan at all", () => {
    const id = conv();
    expect(checkPhaseGate(db(), id, "implement")).toMatchObject({ ok: false, code: "unapproved-plan" });
  });

  it("refuses entering implement while a plan is still in review", () => {
    const id = conv();
    openPlanReview(db(), { id: `p_${id}`, conversationId: id, card: { kind: "plan", version: 1, markdown: "# Plan", checklist: { done: 0, total: 1 } } });
    expect(checkPhaseGate(db(), id, "implement")).toMatchObject({ ok: false, code: "unapproved-plan" });
  });

  it("allows entering implement once the latest plan is approved", () => {
    const id = conv();
    const rowId = `p_${id}`;
    openPlanReview(db(), { id: rowId, conversationId: id, card: { kind: "plan", version: 1, markdown: "# Plan", checklist: { done: 0, total: 1 } } });
    approvePlanRow(db(), rowId);
    expect(checkPhaseGate(db(), id, "implement")).toMatchObject({ ok: true });
  });

  it("every other phase is ungated", () => {
    const id = conv();
    for (const to of ["plan", "review", "fixup", "ship"] as const) {
      expect(checkPhaseGate(db(), id, to)).toMatchObject({ ok: true });
    }
  });
});

describe("checkAdvance: shape + transition + gate", () => {
  it("rejects an unknown phase name", () => {
    const id = conv();
    expect(checkAdvance(db(), id, "plan", "launched")).toMatchObject({ ok: false, code: "invalid-phase" });
  });

  it("rejects implement without an approved plan, even though the transition itself (plan -> implement) is a valid forward step", () => {
    const id = conv();
    expect(checkAdvance(db(), id, "plan", "implement")).toMatchObject({ ok: false, code: "unapproved-plan" });
  });

  it("accepts implement once approved", () => {
    const id = conv();
    const rowId = `p_${id}`;
    openPlanReview(db(), { id: rowId, conversationId: id, card: { kind: "plan", version: 1, markdown: "# Plan", checklist: { done: 0, total: 1 } } });
    approvePlanRow(db(), rowId);
    expect(checkAdvance(db(), id, "plan", "implement")).toMatchObject({ ok: true });
  });

  it("a bad transition is refused before the gate is even consulted", () => {
    const id = conv();
    // plan -> review is a forward skip; implement's gate is irrelevant here.
    expect(checkAdvance(db(), id, "plan", "review")).toMatchObject({ ok: false, code: "skip" });
  });
});

describe("checkEnterMode", () => {
  it("allows entering from a plain, unbound chat", () => {
    expect(checkEnterMode({ skill: null, modePhase: null })).toMatchObject({ ok: true });
  });

  it("refuses when already in ticket mode (phase set)", () => {
    expect(checkEnterMode({ skill: "ticket", modePhase: "implement" })).toMatchObject({ ok: false, message: "already in ticket mode" });
  });

  it("refuses when the skill is ticket even with no phase yet (a legacy bind)", () => {
    expect(checkEnterMode({ skill: "ticket", modePhase: null })).toMatchObject({ ok: false });
  });

  it("refuses when a different skill is already bound", () => {
    const result = checkEnterMode({ skill: "review", modePhase: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("review");
  });
});

describe("nextPhaseLabel / threadStateNote", () => {
  it("steps through the fixed order, 'done' after ship", () => {
    expect(nextPhaseLabel("plan")).toBe("implement");
    expect(nextPhaseLabel("implement")).toBe("review");
    expect(nextPhaseLabel("review")).toBe("fixup");
    expect(nextPhaseLabel("fixup")).toBe("ship");
    expect(nextPhaseLabel("ship")).toBe("done");
  });

  it("formats the exact [thread state] line from the design doc", () => {
    expect(threadStateNote("implement")).toBe("[thread state] mode: ticket · phase: implement (2/5) · next: review");
  });

  it("says next: done on the last phase", () => {
    expect(threadStateNote("ship")).toContain("next: done");
    expect(threadStateNote("ship")).toContain("(5/5)");
  });
});

describe("extractIntro / extractPhaseSection / formatPhaseInstructions", () => {
  const sample = [
    "Intro line one.",
    "Intro line two.",
    "",
    "## plan",
    "",
    "Plan body line one.",
    "Plan body line two.",
    "",
    "## implement",
    "",
    "Implement body.",
  ].join("\n");

  it("extracts everything before the first ## heading", () => {
    expect(extractIntro(sample)).toBe("Intro line one.\nIntro line two.");
  });

  it("returns the whole trimmed text as intro when there are no headings", () => {
    expect(extractIntro("just prose, no headings")).toBe("just prose, no headings");
  });

  it("extracts a named section's body, heading excluded, case-insensitively", () => {
    expect(extractPhaseSection(sample, "plan")).toBe("Plan body line one.\nPlan body line two.");
    expect(extractPhaseSection(sample, "PLAN")).toBe("Plan body line one.\nPlan body line two.");
    expect(extractPhaseSection(sample, "implement")).toBe("Implement body.");
  });

  it("returns null for a phase with no matching heading", () => {
    expect(extractPhaseSection(sample, "ship")).toBeNull();
  });

  it("the next heading of any name ends the section, even mid-match", () => {
    const withExtra = `${sample}\n\n## review\n\nReview body.`;
    expect(extractPhaseSection(withExtra, "implement")).toBe("Implement body.");
  });

  it("formatPhaseInstructions reassembles intro + the section under its own heading", () => {
    expect(formatPhaseInstructions(sample, "plan")).toBe(
      "Intro line one.\nIntro line two.\n\n## plan\n\nPlan body line one.\nPlan body line two.",
    );
  });

  it("formatPhaseInstructions is null when the runbook has no section for that phase", () => {
    expect(formatPhaseInstructions(sample, "ship")).toBeNull();
  });
});

describe("checkLegacyAdopt: adopting a pre-0055 ticket-skill thread (no prior phase)", () => {
  it("refuses without a note — there is no prior phase to reason from", () => {
    const id = conv();
    expect(checkLegacyAdopt(db(), id, "implement")).toMatchObject({ ok: false, code: "needs-note" });
    expect(checkLegacyAdopt(db(), id, "implement", "   ")).toMatchObject({ ok: false, code: "needs-note" });
  });

  it("adopts into plan with a note and no plan approval needed", () => {
    const id = conv();
    expect(checkLegacyAdopt(db(), id, "plan", "starting fresh")).toMatchObject({ ok: true });
  });

  it("refuses implement-or-later without an approved plan, even with a note", () => {
    const id = conv();
    for (const to of ["implement", "review", "fixup", "ship"] as const) {
      expect(checkLegacyAdopt(db(), id, to, "we are already past planning")).toMatchObject({
        ok: false,
        code: "unapproved-plan",
      });
    }
  });

  it("adopts into implement-or-later once the plan is approved", () => {
    const id = conv();
    const rowId = `p_${id}`;
    openPlanReview(db(), { id: rowId, conversationId: id, card: { kind: "plan", version: 1, markdown: "# Plan", checklist: { done: 1, total: 1 } } });
    approvePlanRow(db(), rowId);
    expect(checkLegacyAdopt(db(), id, "review", "already shipped the plan and implementation")).toMatchObject({ ok: true });
  });

  it("rejects an unknown phase name", () => {
    const id = conv();
    expect(checkLegacyAdopt(db(), id, "sprint", "wherever")).toMatchObject({ ok: false, code: "invalid-phase" });
  });
});

describe("runbook <-> rule agreement: every advance_phase({to}) in skills/ticket/SKILL.md is a valid transition", () => {
  const body = readFileSync(path.join(process.cwd(), "skills", "ticket", "SKILL.md"), "utf8")
    .replace(/^---\n[\s\S]*?\n---\n/, ""); // strip front matter, same as lib/skill-files.ts

  it("every phase section's own advance_phase calls are allowed by validateTransition (plan gate ignored)", () => {
    const checked: string[] = [];
    for (const from of TICKET_PHASES) {
      const section = extractPhaseSection(body, from);
      expect(section, `## ${from} section exists`).not.toBeNull();
      const calls = [...section!.matchAll(/advance_phase\(\{\s*to:\s*"(\w+)"/g)].map((m) => m[1]!);
      // "ship" is terminal — it reports and stops, no further advance_phase.
      if (from !== "ship") {
        expect(calls.length, `## ${from} mentions at least one advance_phase`).toBeGreaterThan(0);
      }
      for (const to of calls) {
        expect(isTicketPhase(to), `"${to}" in ## ${from} is a real phase`).toBe(true);
        const result = validateTransition(from, to as TicketPhase, "runbook-stated note");
        expect(result, `${from} -> ${to} (as the runbook tells the agent to call it)`).toMatchObject({ ok: true });
        checked.push(`${from}->${to}`);
      }
    }
    // Sanity: this actually exercised something (a future edit that
    // removes every advance_phase call would otherwise pass vacuously).
    expect(checked.length).toBeGreaterThan(0);
  });
});
