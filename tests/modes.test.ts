import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkEnterMode,
  checkLegacyAdopt,
  findPhase,
  isModeSkill,
  parseModeSkill,
  renderModeEntry,
  renderPhaseHandoff,
  renderPhaseList,
  renderPhaseSection,
  threadStateNote,
  validateTransition,
} from "../lib/agent/mode-ids";

describe("isModeSkill", () => {
  it("true only for an explicit mode flag, never inferred from an id", () => {
    expect(isModeSkill(true)).toBe(true);
    expect(isModeSkill(false)).toBe(false);
    expect(isModeSkill(null)).toBe(false);
    expect(isModeSkill(undefined)).toBe(false);
  });
});

describe("parseModeSkill", () => {
  it("a body with no phase headings: everything is brief, no shared", () => {
    const body = "# Thing\n\nJust some prose.\n\n## Notes\n\nMore prose.";
    const parsed = parseModeSkill(body);
    expect(parsed.phases).toEqual([]);
    expect(parsed.shared).toBeNull();
    expect(parsed.brief).toContain("# Thing");
    expect(parsed.brief).toContain("Just some prose.");
    expect(parsed.brief).toContain("## Notes");
    expect(parsed.brief).toContain("More prose.");
  });

  it("no Shared section: shared is null, phases still parse", () => {
    const body = "Brief.\n\n## Phase: Plan\n\nPlan body.\n\n## Phase: Ship\n\nShip body.";
    const parsed = parseModeSkill(body);
    expect(parsed.shared).toBeNull();
    expect(parsed.phases).toEqual([
      { id: "plan", name: "Plan", body: "Plan body." },
      { id: "ship", name: "Ship", body: "Ship body." },
    ]);
  });

  it("### and deeper headings are content, not section boundaries", () => {
    const body = ["Brief.", "", "## Phase: Implement", "", "### Checklist", "", "- step one", "- step two"].join("\n");
    const parsed = parseModeSkill(body);
    expect(parsed.phases).toHaveLength(1);
    expect(parsed.phases[0]!.body).toBe("### Checklist\n\n- step one\n- step two");
  });

  it("odd phase names slugify sensibly", () => {
    const body = "## Phase: Write docs!\n\nDo it.";
    const parsed = parseModeSkill(body);
    expect(parsed.phases[0]).toMatchObject({ id: "write-docs", name: "Write docs!" });
  });

  it("a name that slugs to empty (punctuation only) is not a declared phase — it joins the brief instead", () => {
    const body = "Intro.\n\n## Phase: !@#\n\nThis would collide with the phaseless sentinel.\n\n## Phase: Plan\n\nPlan body.";
    const parsed = parseModeSkill(body);
    expect(parsed.phases).toEqual([{ id: "plan", name: "Plan", body: "Plan body." }]);
    expect(parsed.brief).toContain("## Phase: !@#");
    expect(parsed.brief).toContain("This would collide with the phaseless sentinel.");
  });

  it("duplicate phase ids: first wins, later ones are dropped entirely", () => {
    const body = [
      "## Phase: Review",
      "",
      "First review body.",
      "",
      "## Phase: review",
      "",
      "Second review body (different case, same slug).",
    ].join("\n");
    const parsed = parseModeSkill(body);
    expect(parsed.phases).toHaveLength(1);
    expect(parsed.phases[0]).toMatchObject({ id: "review", name: "Review", body: "First review body." });
  });

  it("`## Phase:` label is case-insensitive", () => {
    const body = "## phase: QA\n\nQA body.";
    const parsed = parseModeSkill(body);
    expect(parsed.phases[0]).toMatchObject({ id: "qa", name: "QA" });
  });

  it("tolerates whitespace before the colon: `## Phase : Name`", () => {
    const body = "## Phase : QA\n\nQA body.";
    const parsed = parseModeSkill(body);
    expect(parsed.phases[0]).toMatchObject({ id: "qa", name: "QA" });
  });

  it("ignores ## headings inside a fenced code block (``` or ~~~), for every section kind", () => {
    const body = [
      "## Phase: Plan",
      "",
      "Run this:",
      "",
      "```",
      "## Phase: Not Real",
      "## Shared",
      "```",
      "",
      "Still Plan body.",
      "",
      "## Phase: Ship",
      "",
      "~~~",
      "## Phase: Also Not Real",
      "~~~",
      "",
      "Ship body.",
    ].join("\n");
    const parsed = parseModeSkill(body);
    expect(parsed.phases.map((p) => p.id)).toEqual(["plan", "ship"]);
    expect(parsed.phases[0]!.body).toContain("## Phase: Not Real");
    expect(parsed.phases[0]!.body).toContain("## Shared");
    expect(parsed.phases[0]!.body).toContain("Still Plan body.");
    expect(parsed.phases[1]!.body).toContain("## Phase: Also Not Real");
    expect(parsed.phases[1]!.body).toContain("Ship body.");
  });

  it("a ``` fence is not closed by a ~~~ line (different fence characters)", () => {
    const body = ["## Phase: Plan", "", "```", "~~~", "## Phase: Fake", "```", "", "Plan body."].join("\n");
    const parsed = parseModeSkill(body);
    expect(parsed.phases).toHaveLength(1);
    expect(parsed.phases[0]!.body).toContain("## Phase: Fake");
    expect(parsed.phases[0]!.body).toContain("Plan body.");
  });

  it("`## Shared` is case-insensitive and excluded from the brief", () => {
    const body = "Brief text.\n\n## shared\n\nShared text.\n\n## Phase: Plan\n\nPlan body.";
    const parsed = parseModeSkill(body);
    expect(parsed.shared).toBe("Shared text.");
    expect(parsed.brief).toBe("Brief text.");
  });

  it("the brief collects every non-phase, non-Shared `##` section, in document order", () => {
    const body = [
      "# Title",
      "",
      "Intro.",
      "",
      "## Background",
      "",
      "Some context.",
      "",
      "## Phase: Plan",
      "",
      "Plan body.",
      "",
      "## Notes",
      "",
      "Trailing note.",
    ].join("\n");
    const parsed = parseModeSkill(body);
    expect(parsed.brief).toBe("# Title\n\nIntro.\n\n## Background\n\nSome context.\n\n## Notes\n\nTrailing note.");
    expect(parsed.phases).toEqual([{ id: "plan", name: "Plan", body: "Plan body." }]);
  });
});

describe("findPhase", () => {
  const phases = [
    { id: "plan", name: "Plan", body: "" },
    { id: "write-docs", name: "Write docs!", body: "" },
  ];

  it("matches by id or case-insensitive name", () => {
    expect(findPhase(phases, "plan")).toMatchObject({ id: "plan" });
    expect(findPhase(phases, "PLAN")).toMatchObject({ id: "plan" });
    expect(findPhase(phases, "write-docs")).toMatchObject({ id: "write-docs" });
    expect(findPhase(phases, "Write docs!")).toMatchObject({ id: "write-docs" });
  });

  it("returns null for no match", () => {
    expect(findPhase(phases, "ship")).toBeNull();
  });
});

describe("validateTransition", () => {
  const phases = [
    { id: "plan", name: "Plan", body: "" },
    { id: "implement", name: "Implement", body: "" },
    { id: "review", name: "Review", body: "" },
    { id: "fixup", name: "Fixup", body: "" },
    { id: "ship", name: "Ship", body: "" },
  ];

  it("the next phase in document order needs no note", () => {
    expect(validateTransition(phases, "plan", "implement")).toMatchObject({ ok: true });
    expect(validateTransition(phases, "implement", "review")).toMatchObject({ ok: true });
  });

  it("an unknown phase refuses, listing the declared names", () => {
    const result = validateTransition(phases, "plan", "sprint");
    expect(result).toMatchObject({ ok: false, code: "unknown-phase" });
    expect(result.message).toContain("Plan");
    expect(result.message).toContain("Ship");
  });

  it("matches the target by id or case-insensitive name", () => {
    expect(validateTransition(phases, "plan", "IMPLEMENT")).toMatchObject({ ok: true });
  });

  it("same phase is a no-op refusal", () => {
    expect(validateTransition(phases, "plan", "plan")).toMatchObject({ ok: false, code: "same-phase" });
  });

  it("a backward move needs a non-empty note", () => {
    expect(validateTransition(phases, "ship", "plan")).toMatchObject({ ok: false, code: "needs-note" });
    expect(validateTransition(phases, "ship", "plan", "   ")).toMatchObject({ ok: false, code: "needs-note" });
    expect(validateTransition(phases, "ship", "plan", "found a design flaw")).toMatchObject({ ok: true });
  });

  it("a forward skip needs a non-empty note (no more fixed review->ship exception)", () => {
    expect(validateTransition(phases, "plan", "review")).toMatchObject({ ok: false, code: "needs-note" });
    expect(validateTransition(phases, "plan", "review", "skip ahead")).toMatchObject({ ok: true });
    expect(validateTransition(phases, "review", "ship", "clean, nothing to fix")).toMatchObject({ ok: true });
  });

  it("a loop (fixup back to review) needs a note too — no hardcoded exception", () => {
    expect(validateTransition(phases, "fixup", "review")).toMatchObject({ ok: false, code: "needs-note" });
    expect(validateTransition(phases, "fixup", "review", "more findings")).toMatchObject({ ok: true });
  });
});

describe("validateTransition: zero or one phase", () => {
  it("is never reachable on a zero-phase mode (findPhase has nothing to match)", () => {
    expect(validateTransition([], "", "anything")).toMatchObject({ ok: false, code: "unknown-phase" });
  });
});

describe("checkLegacyAdopt", () => {
  const phases = [
    { id: "plan", name: "Plan", body: "" },
    { id: "implement", name: "Implement", body: "" },
  ];

  it("a zero-phase mode refuses outright", () => {
    expect(checkLegacyAdopt([], "plan", "starting here")).toMatchObject({ ok: false, code: "no-phases" });
  });

  it("an unknown phase refuses, listing declared names", () => {
    expect(checkLegacyAdopt(phases, "sprint", "wherever")).toMatchObject({ ok: false, code: "unknown-phase" });
  });

  it("any declared phase is reachable, but only with a non-empty note", () => {
    expect(checkLegacyAdopt(phases, "implement")).toMatchObject({ ok: false, code: "needs-note" });
    expect(checkLegacyAdopt(phases, "implement", "   ")).toMatchObject({ ok: false, code: "needs-note" });
    expect(checkLegacyAdopt(phases, "implement", "already mid-build")).toMatchObject({ ok: true });
    expect(checkLegacyAdopt(phases, "plan", "starting fresh")).toMatchObject({ ok: true });
  });
});

describe("checkEnterMode", () => {
  it("allows entering from a plain, unbound chat", () => {
    expect(checkEnterMode({ skill: null, modePhase: null })).toMatchObject({ ok: true });
  });

  it("refuses when already in a mode (a real phase)", () => {
    expect(checkEnterMode({ skill: "ticket", modePhase: "implement" })).toMatchObject({ ok: false, message: "already in a mode" });
  });

  it("refuses when already in a phaseless mode (modePhase \"\")", () => {
    expect(checkEnterMode({ skill: "onboarding", modePhase: "" })).toMatchObject({ ok: false, message: "already in a mode" });
  });

  it("refuses when any skill is already bound, even with no phase yet (legacy bind)", () => {
    const result = checkEnterMode({ skill: "ticket", modePhase: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("ticket");
  });

  it("refuses when a different (non-mode) skill is already bound", () => {
    const result = checkEnterMode({ skill: "review", modePhase: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("review");
  });
});

describe("threadStateNote", () => {
  const phases = [
    { id: "plan", name: "Plan", body: "" },
    { id: "implement", name: "Implement", body: "" },
    { id: "review", name: "Review", body: "" },
    { id: "fixup", name: "Fixup", body: "" },
    { id: "ship", name: "Ship", body: "" },
  ];

  it("formats the exact [thread state] line from the design doc", () => {
    expect(threadStateNote("ticket", phases, "implement")).toBe(
      "[thread state] mode: ticket · phase: Implement (2/5) · next: Review",
    );
  });

  it("says next: done on the last phase", () => {
    const note = threadStateNote("ticket", phases, "ship");
    expect(note).toContain("next: done");
    expect(note).toContain("(5/5)");
  });

  it("a stored phase no longer declared (heading renamed mid-run) says so plainly, listing the current phases", () => {
    const note = threadStateNote("ticket", phases, "gone");
    expect(note).toBe(
      "[thread state] mode: ticket · phase: gone (not declared — advance_phase to one of: Plan, Implement, Review, Fixup, Ship)",
    );
    expect(note).not.toContain("(0/5)");
    expect(note).not.toContain("next: done");
  });

  it("a stale phase on a now-zero-phase mode lists \"none\"", () => {
    expect(threadStateNote("ticket", [], "gone")).toBe(
      "[thread state] mode: ticket · phase: gone (not declared — advance_phase to one of: none)",
    );
  });
});

describe("renderPhaseSection / renderPhaseList / renderModeEntry", () => {
  const parsed = parseModeSkill(
    [
      "Brief paragraph.",
      "",
      "## Shared",
      "",
      "Shared context.",
      "",
      "## Phase: Plan",
      "",
      "Plan body.",
      "",
      "## Phase: Ship",
      "",
      "Ship body.",
    ].join("\n"),
  );

  it("renderPhaseSection reattaches the heading", () => {
    expect(renderPhaseSection(parsed.phases[0]!)).toBe("## Plan\n\nPlan body.");
  });

  it("renderPhaseList joins names with an arrow", () => {
    expect(renderPhaseList(parsed.phases)).toBe("Phases: Plan → Ship");
  });

  it("renderModeEntry assembles brief + phase list + Shared + first phase", () => {
    expect(renderModeEntry(parsed)).toBe(
      "Brief paragraph.\n\nPhases: Plan → Ship\n\n## Shared\n\nShared context.\n\n## Plan\n\nPlan body.",
    );
  });

  it("renderModeEntry drops a missing Shared or empty phase list gracefully", () => {
    const noShared = parseModeSkill("Brief only.\n\n## Phase: Plan\n\nPlan body.");
    expect(renderModeEntry(noShared)).toBe("Brief only.\n\nPhases: Plan\n\n## Plan\n\nPlan body.");

    const noPhases = parseModeSkill("Just a brief, no phases.");
    expect(renderModeEntry(noPhases)).toBe("Just a brief, no phases.");
  });
});

describe("renderPhaseHandoff (0055 v7 part B)", () => {
  const phase = { id: "qa", name: "QA", body: "Run the test suite and file findings." };

  it("contains the phase framing, Shared, and only that phase's section, task last", () => {
    const text = renderPhaseHandoff({ modeName: "Ticket", phase, shared: "Branch naming conventions.", task: "check PR #4" });
    expect(text).toContain('You are doing the "QA" phase of a "Ticket" run.');
    expect(text).toContain("Do only this phase; other phases are handled separately.");
    expect(text).toContain("Your result goes back to the orchestrator.");
    expect(text).toContain("Branch naming conventions.");
    expect(text).toContain("Run the test suite and file findings.");
    expect(text.endsWith("Task from the orchestrator:\ncheck PR #4")).toBe(true);
    // Order: header, then Shared, then the phase body, then the task.
    const header = text.indexOf('You are doing the "QA"');
    const shared = text.indexOf("Branch naming conventions.");
    const body = text.indexOf("Run the test suite");
    const task = text.indexOf("Task from the orchestrator:");
    expect(header).toBeLessThan(shared);
    expect(shared).toBeLessThan(body);
    expect(body).toBeLessThan(task);
  });

  it("never contains the brief or other phases — the caller passes only THIS phase", () => {
    const text = renderPhaseHandoff({ modeName: "Ticket", phase, shared: null, task: "x" });
    expect(text).not.toContain("coordinate");
    expect(text).not.toContain("Plan phase body");
    expect(text).not.toContain("Implement phase body");
  });

  it("drops the Shared paragraph entirely when there is none", () => {
    const text = renderPhaseHandoff({ modeName: "Ticket", phase, shared: null, task: "x" });
    expect(text).toBe(
      'You are doing the "QA" phase of a "Ticket" run. Do only this phase; other phases are handled ' +
        "separately. Your result goes back to the orchestrator.\n\n" +
        "Run the test suite and file findings.\n\n---\nTask from the orchestrator:\nx",
    );
  });
});

describe("runbook <-> rule agreement: every advance_phase({to}) in skills/ticket/SKILL.md names a declared phase", () => {
  const raw = readFileSync(path.join(process.cwd(), "skills", "ticket", "SKILL.md"), "utf8").replace(
    /^---\n[\s\S]*?\n---\n/,
    "",
  ); // strip front matter, same as lib/skill-files.ts
  const parsed = parseModeSkill(raw);

  it("has at least one phase and at least one advance_phase call per non-terminal phase", () => {
    expect(parsed.phases.length).toBeGreaterThan(0);
    const checked: string[] = [];
    for (const phase of parsed.phases) {
      const calls = [...phase.body.matchAll(/advance_phase\(\{\s*to:\s*"([^"]+)"/g)].map((m) => m[1]!);
      // "Ship" is terminal — it reports and stops, no further advance_phase.
      if (phase.id !== "ship") {
        expect(calls.length, `## Phase: ${phase.name} mentions at least one advance_phase`).toBeGreaterThan(0);
      }
      for (const to of calls) {
        expect(findPhase(parsed.phases, to), `"${to}" named in ## Phase: ${phase.name} is a declared phase`).not.toBeNull();
        checked.push(`${phase.id}->${to}`);
      }
    }
    // Sanity: this actually exercised something (a future edit that
    // removes every advance_phase call would otherwise pass vacuously).
    expect(checked.length).toBeGreaterThan(0);
  });
});
