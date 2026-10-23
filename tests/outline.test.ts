import { describe, expect, it } from "vitest";
import type { ModelMessage, UIMessage } from "ai";
import { db } from "../db";
import { appendMessages, ensureConversation, listModelMessages, listPendingInputs } from "../db/chat";
import { getOutlineRow, outlineState } from "../db/outlines";
import { projects } from "../db/schema";
import { phaseFromMessages } from "../lib/thread-phase";
import { renderWake } from "../lib/chat/wake";
import { editOutline } from "../lib/chat/outline-edit";
import {
  acceptOutlineApproved,
  acceptOutlinePreview,
  approveOutline,
  updateOutline,
  type ApproveOutlineDeps,
} from "../lib/agent/tools/outline";
import {
  deriveOutline,
  deriveOutlineTrayContext,
  diffOutlineSteps,
  isOutline,
  outlineChangeSummary,
  outlineChipLabel,
  outlineTraySummary,
  prependOutlineHandoff,
  renderOutlineEdit,
  renderOutlineHandoff,
  renderThreadStateNote,
  runnerGate,
  splitOutlineContext,
  validateOutline,
  type Outline,
  type Step,
} from "../lib/outline";

/**
 * 0064 — the outline: the tree. Pure derivations (validation caps,
 * legacy update_status compat, chip, the thread-state note, the by-id
 * diff), then the review row lifecycle against a real db (open →
 * supersede → approve, same "store + cores" idiom as tests/plan.test.ts)
 * proving propose never suspends, approve wakes, and a newer proposal
 * supersedes the open one.
 */

function outline(goal: string, steps: Outline["steps"], note?: string): Outline {
  return note ? { goal, steps, note } : { goal, steps };
}

describe("validateOutline", () => {
  it("normalizes a rewrite, trims blanks, and drops an empty note", () => {
    expect(
      validateOutline({
        goal: "  Ship the widget  ",
        steps: [{ id: "plan", label: "  Plan  ", state: "active", detail: "  " }],
        note: "  ",
      }),
    ).toEqual({ goal: "Ship the widget", steps: [{ id: "plan", label: "Plan", state: "active" }] });
  });

  it("refuses a missing goal, an empty step list, and a bad state", () => {
    expect(validateOutline({ steps: [{ id: "a", label: "A", state: "active" }] })).toMatchObject({ ok: false, code: "invalid" });
    expect(validateOutline({ goal: "x", steps: [] })).toMatchObject({ ok: false });
    expect(validateOutline({ goal: "x", steps: [{ id: "a", label: "A", state: "later" }] })).toMatchObject({ ok: false });
  });

  it("refuses duplicate ids anywhere in the tree", () => {
    const res = validateOutline({
      goal: "x",
      steps: [
        { id: "a", label: "A", state: "pending" },
        { id: "a", label: "A again", state: "pending" },
      ],
    });
    expect(res).toMatchObject({ ok: false, message: expect.stringContaining("duplicate step id") });
  });

  it("refuses a runner on a child step", () => {
    const res = validateOutline({
      goal: "x",
      steps: [{ id: "a", label: "A", state: "active", children: [{ id: "b", label: "B", state: "pending", runner: "self" }] }],
    });
    expect(res).toMatchObject({ ok: false, message: expect.stringContaining("top-level") });
  });

  it("accepts a top-level runner: auto, self, thread, and a pinned harness route", () => {
    const res = validateOutline({
      goal: "x",
      steps: [
        { id: "a", label: "A", state: "active", runner: "self" },
        { id: "b", label: "B", state: "pending", runner: { harness: "claude", model: "opus" } },
      ],
    });
    expect(res).toMatchObject({ steps: [{ runner: "self" }, { runner: { harness: "claude", model: "opus" } }] });
  });

  it("refuses an invalid runner shape", () => {
    const res = validateOutline({ goal: "x", steps: [{ id: "a", label: "A", state: "active", runner: { harness: "nope" } }] });
    expect(res).toMatchObject({ ok: false, message: expect.stringContaining("runner") });
  });

  it("refuses two active top-level steps on write (the runner gate is unambiguous)", () => {
    const twoActive = validateOutline({
      goal: "x",
      steps: [
        { id: "a", label: "A", state: "active" },
        { id: "b", label: "B", state: "active", runner: "self" },
      ],
    });
    expect(twoActive).toMatchObject({ ok: false, message: expect.stringContaining("at most one top-level step may be active") });
    // One active top-level step is fine; several active CHILDREN still are.
    expect(validateOutline({ goal: "x", steps: [{ id: "a", label: "A", state: "active", children: [
      { id: "c1", label: "C1", state: "active" },
      { id: "c2", label: "C2", state: "active" },
    ] }] })).not.toHaveProperty("ok");
  });

  it("caps text lengths on the write paths (goal, label, detail, note)", () => {
    const over = (n: number) => "x".repeat(n + 1);
    const step = (extra: Record<string, string>) => ({ id: "a", label: "A", state: "active" as const, ...extra });
    expect(validateOutline({ goal: over(300), steps: [step({})] })).toMatchObject({ ok: false, message: expect.stringContaining("goal") });
    expect(validateOutline({ goal: "x", steps: [step({ label: over(200) })] })).toMatchObject({ ok: false, message: expect.stringContaining("label") });
    expect(validateOutline({ goal: "x", steps: [step({ detail: over(500) })] })).toMatchObject({ ok: false, message: expect.stringContaining("detail") });
    expect(validateOutline({ goal: "x", steps: [step({})], note: over(500) })).toMatchObject({ ok: false, message: expect.stringContaining("note") });
    // At the cap itself everything passes (same numbers as the tool schema).
    expect(validateOutline({ goal: "x".repeat(300), steps: [step({ detail: "d".repeat(500) })], note: "n".repeat(500) })).not.toHaveProperty("ok");
  });

  it("caps depth at 4", () => {
    // depth 1 (top) -> 2 -> 3 -> 4 is fine; a 5th level is refused.
    const fine = validateOutline({
      goal: "x",
      steps: [{ id: "a", label: "A", state: "active", children: [{ id: "b", label: "B", state: "active", children: [{ id: "c", label: "C", state: "active", children: [{ id: "d", label: "D", state: "pending" }] }] }] }],
    });
    expect(fine).toMatchObject({ goal: "x" });
    const tooDeep = validateOutline({
      goal: "x",
      steps: [{ id: "a", label: "A", state: "active", children: [{ id: "b", label: "B", state: "active", children: [{ id: "c", label: "C", state: "active", children: [{ id: "d", label: "D", state: "active", children: [{ id: "e", label: "E", state: "pending" }] }] }] }] }],
    });
    expect(tooDeep).toMatchObject({ ok: false, message: expect.stringContaining("nested too deep") });
  });

  it("caps the total node count at 200", () => {
    const steps = Array.from({ length: 201 }, (_, i) => ({ id: `s${i}`, label: `S${i}`, state: "pending" as const }));
    expect(validateOutline({ goal: "x", steps })).toMatchObject({ ok: false, message: expect.stringContaining("200") });
  });
});

const implement = outline("Ship the widget", [
  { id: "plan", label: "Plan", state: "done" },
  {
    id: "implement",
    label: "Implement",
    state: "active",
    runner: "auto",
    children: [
      { id: "column", label: "column", state: "done" },
      { id: "card", label: "card", state: "done" },
      { id: "tests", label: "tests", state: "pending" },
    ],
  },
  { id: "ship", label: "Ship", state: "pending" },
]);

const resultRow = (toolCallId: string, output: unknown): ModelMessage =>
  ({
    role: "tool",
    content: [{ type: "tool-result", toolCallId, toolName: "update_outline", output: { type: "json", value: output as never } }],
  }) as ModelMessage;

describe("outlineChipLabel", () => {
  it("uses the active step's children as the fraction", () => {
    expect(outlineChipLabel(implement)).toEqual({ label: "Implement · 2/3", tone: "running" });
  });

  it("a blocked step wins over the fraction", () => {
    const o = outline("x", [
      { id: "plan", label: "Plan", state: "done" },
      { id: "implement", label: "Implement", state: "active", children: [{ id: "auth", label: "auth", state: "blocked" }] },
    ]);
    expect(outlineChipLabel(o)).toEqual({ label: "auth · needs you", tone: "warn" });
  });

  it("with no active step, names the last done step; all pending names the first", () => {
    const done = outline("x", [
      { id: "plan", label: "Plan", state: "done" },
      { id: "ship", label: "Ship", state: "done" },
    ]);
    expect(outlineChipLabel(done)).toEqual({ label: "Ship · 2/2", tone: "ok" });
    const pending = outline("x", [
      { id: "plan", label: "Plan", state: "pending" },
      { id: "ship", label: "Ship", state: "pending" },
    ]);
    expect(outlineChipLabel(pending)).toEqual({ label: "Plan · 0/2", tone: "ok" });
  });
});

describe("outlineTraySummary (0079: the composer tray's collapsed bar)", () => {
  it("one segment per top-level step, the active step's label, and the outline's own d/n", () => {
    expect(outlineTraySummary(implement, false)).toEqual({
      segments: [
        { id: "plan", state: "done" },
        { id: "implement", state: "active" },
        { id: "ship", state: "pending" },
      ],
      done: 1,
      total: 3,
      label: "Implement",
      tone: "running",
      needsYou: false,
    });
  });

  it("a blocked step always needs you, regardless of the review flag", () => {
    const o = outline("x", [
      { id: "plan", label: "Plan", state: "done" },
      { id: "implement", label: "Implement", state: "active", children: [{ id: "auth", label: "auth", state: "blocked" }] },
    ]);
    expect(outlineTraySummary(o, false)).toMatchObject({ label: "auth", tone: "warn", needsYou: true });
  });

  it("an open review needs you even with no active or blocked step", () => {
    const done = outline("x", [
      { id: "plan", label: "Plan", state: "done" },
      { id: "ship", label: "Ship", state: "done" },
    ]);
    expect(outlineTraySummary(done, false)).toMatchObject({ label: "Ship", tone: "ok", needsYou: false });
    expect(outlineTraySummary(done, true)).toMatchObject({ label: "Ship", tone: "ok", needsYou: true });
  });

  it("names the first step for an all-pending outline, same fallback as the chip", () => {
    const pending = outline("x", [
      { id: "plan", label: "Plan", state: "pending" },
      { id: "ship", label: "Ship", state: "pending" },
    ]);
    expect(outlineTraySummary(pending, false)).toMatchObject({ label: "Plan", done: 0, total: 2 });
  });
});

describe("deriveOutline", () => {
  const ui = (version: number, o: Outline, proposed = false) => ({
    role: "assistant",
    parts: [{ type: "tool-update_outline", state: "output-available", output: { ok: true, version, outline: o, proposed, next: "ok" } }],
  });
  const legacyUi = (steps: { label: string; state: "pending" | "active" | "done" }[]) => ({
    role: "assistant",
    parts: [{ type: "tool-update_status", state: "output-available", output: { ok: true, steps } }],
  });

  it("the last rewrite is current and history keeps every one", () => {
    const first = outline("x", [{ id: "a", label: "A", state: "active" }]);
    const derived = deriveOutline([ui(1, first), ui(2, implement)]);
    expect(derived.history.map((h) => h.outline)).toEqual([first, implement]);
    expect(derived.current?.outline).toEqual(implement);
    expect(derived.stale).toBe(false);
    expect(derived.review).toBeNull();
  });

  it("treats an owner edit row as the next snapshot", () => {
    const edited = outline("edited", [{ id: "a", label: "Renamed", state: "active" }]);
    const derived = deriveOutline([
      ui(1, implement, true),
      { role: "user", content: renderOutlineEdit({ version: 2, outline: edited, proposed: true }) },
    ]);
    expect(derived.current).toMatchObject({ version: 2, outline: edited, proposed: true });
    expect(derived.history).toHaveLength(2);
    expect(derived.review?.version).toBe(2);
  });

  it("reads a legacy update_status result as an outline with no goal and slugged, unique ids", () => {
    const derived = deriveOutline([
      legacyUi([
        { label: "Plan", state: "done" },
        { label: "Plan", state: "active" },
      ]),
    ]);
    expect(derived.current?.outline.goal).toBe("");
    expect(derived.current?.outline.steps.map((s) => s.id)).toEqual(["plan", "plan-2"]);
    expect(derived.current?.outline.steps.every((s) => s.runner === "auto")).toBe(true);
  });

  it("still derives a legacy update_status snapshot with two active steps (write-time rule only)", () => {
    const derived = deriveOutline([
      legacyUi([
        { label: "Plan", state: "active" },
        { label: "Implement", state: "active" },
      ]),
    ]);
    expect(derived.current?.outline.steps).toHaveLength(2);
    expect(derived.current?.outline.steps.filter((s) => s.state === "active")).toHaveLength(2);
  });

  it("a propose:true result opens review; approval (by wake text or accept_outline) clears it", () => {
    const proposed = deriveOutline([ui(1, implement, true)]);
    expect(proposed.review?.version).toBe(1);
    const approvedByWake = deriveOutline([
      ui(1, implement, true),
      { role: "user", content: "[outline v1 approved] — /c/x" },
    ]);
    expect(approvedByWake.review).toBeNull();
    const approvedByTool = deriveOutline([
      ui(1, implement, true),
      { role: "assistant", parts: [{ type: "tool-accept_outline", state: "output-available", output: { approved: true } }] },
    ]);
    expect(approvedByTool.review).toBeNull();
  });

  it("recognizes the approval wake text produced by the wake renderer", () => {
    const text = renderWake({
      kind: "outline",
      id: "outline2",
      name: "outline v2",
      status: "approved",
      detail: "go",
      url: "/c/x",
    });
    expect(deriveOutline([ui(2, implement, true), { role: "user", content: text }]).review).toBeNull();
  });

  it("a newer proposal supersedes the open one", () => {
    const derived = deriveOutline([ui(1, implement, true), ui(2, implement, true)]);
    expect(derived.review?.version).toBe(2);
  });

  it("a wake closed by a later user message, with no update_outline, is stale", () => {
    const messages = [
      ui(1, implement),
      { role: "user", metadata: { runEvent: { kind: "thread" } }, parts: [{ type: "text", text: "[review finished] — /c/x" }] },
      { role: "assistant", parts: [{ type: "text", text: "noted" }] },
      { role: "user", parts: [{ type: "text", text: "ok" }] },
    ];
    expect(deriveOutline(messages).stale).toBe(true);
  });

  it("update_outline after the wake clears stale", () => {
    const messages = [ui(1, implement), { role: "user", content: "[review finished] — /c/x" }, ui(2, implement)];
    expect(deriveOutline(messages).stale).toBe(false);
  });
});

describe("deriveOutlineTrayContext (0079: the composer tray's whole-transcript feed)", () => {
  const toolMsg = (id: string, output: unknown): UIMessage =>
    ({
      id,
      role: "assistant",
      parts: [{ type: "tool-update_outline", toolCallId: id, state: "output-available", input: {}, output }],
    }) as unknown as UIMessage;

  it("is null with no update_outline call", () => {
    expect(deriveOutlineTrayContext([])).toBeNull();
  });

  it("carries the current outline, no previous, no open review", () => {
    const msgs = [toolMsg("o1", { ok: true, version: 1, proposed: false, outline: implement, next: "ok" })];
    expect(deriveOutlineTrayContext(msgs)).toEqual({
      current: { version: 1, outline: implement, proposed: false },
      previous: null,
      openReviewId: null,
      approved: false,
      stale: false,
    });
  });

  it("carries the previous snapshot and the open review id once a rewrite proposes", () => {
    const second = outline("Ship the widget v2", implement.steps);
    const msgs = [
      toolMsg("o1", { ok: true, version: 1, proposed: false, outline: implement, next: "ok" }),
      toolMsg("o2", { ok: true, version: 2, proposed: true, outline: second, next: "ok" }),
    ];
    const ctx = deriveOutlineTrayContext(msgs);
    expect(ctx?.current).toEqual({ version: 2, outline: second, proposed: true });
    expect(ctx?.previous).toEqual({ version: 1, outline: implement });
    expect(ctx?.openReviewId).toBe("o2");
  });
});

describe("renderThreadStateNote", () => {
  it("renders goal, active + runner + open children, next + runner, and the call-to-action", () => {
    const o = outline("Ship the widget", [
      { id: "plan", label: "Plan", state: "done" },
      {
        id: "implement",
        label: "Implement",
        state: "active",
        runner: { harness: "claude", model: "opus" },
        children: [
          { id: "column", label: "column", state: "done" },
          { id: "tests", label: "tests", state: "pending" },
        ],
      },
      { id: "ship", label: "Ship", state: "pending", runner: "self" },
    ]);
    const derived = deriveOutline([{ role: "assistant", parts: [{ type: "tool-update_outline", state: "output-available", output: { ok: true, version: 1, outline: o, proposed: false, next: "ok" } }] }]);
    const note = renderThreadStateNote(derived);
    expect(note).toContain("goal: Ship the widget");
    expect(note).toContain("active: Implement (claude · opus)");
    expect(note).toContain("open: tests (pending)");
    expect(note).toContain("next: Ship (self)");
    expect(note).toContain("if this changed, call update_outline");
  });

  it("seeds from declared phases when there is no outline yet, and returns null with neither", () => {
    const empty = deriveOutline([]);
    expect(renderThreadStateNote(empty)).toBeNull();
  });

  it("marks stale and an open review as needs-you in the chip", () => {
    const proposed = deriveOutline([{ role: "assistant", parts: [{ type: "tool-update_outline", state: "output-available", output: { ok: true, version: 3, outline: implement, proposed: true, next: "ok" } }] }]);
    expect(renderThreadStateNote(proposed)).toContain("Outline v3 · needs you");
    expect(renderThreadStateNote({ ...proposed, stale: true })).toContain("(stale)");
  });
});

describe("diffOutlineSteps", () => {
  it("marks added, removed, and state-changed steps by id", () => {
    const before = outline("x", [
      { id: "a", label: "A", state: "pending" },
      { id: "b", label: "B", state: "pending" },
    ]);
    const after = outline("x", [
      { id: "a", label: "A", state: "done" },
      { id: "c", label: "C", state: "pending" },
    ]);
    const diff = diffOutlineSteps(before, after);
    expect(diff).toEqual(
      expect.arrayContaining([
        { id: "a", label: "A", kind: "state-changed", fromState: "pending", toState: "done" },
        { id: "c", label: "C", kind: "added", toState: "pending" },
        { id: "b", label: "B", kind: "removed", fromState: "pending" },
      ]),
    );
  });
});

describe("outlineChangeSummary (0079: the slimmed card's one-liner)", () => {
  it("summarizes when every change is a step finishing", () => {
    const before = outline("x", [
      { id: "a", label: "A", state: "active" },
      { id: "b", label: "B", state: "pending" },
    ]);
    const after = outline("x", [
      { id: "a", label: "A", state: "done" },
      { id: "b", label: "B", state: "done" },
    ]);
    expect(outlineChangeSummary(diffOutlineSteps(before, after))).toBe("2 steps done");
  });

  it("singular for one finished step", () => {
    const before = outline("x", [{ id: "a", label: "A", state: "active" }]);
    const after = outline("x", [{ id: "a", label: "A", state: "done" }]);
    expect(outlineChangeSummary(diffOutlineSteps(before, after))).toBe("1 step done");
  });

  it("omits anything that isn't purely steps finishing", () => {
    const before = outline("x", [{ id: "a", label: "A", state: "pending" }]);
    const addedOnly = outline("x", [
      { id: "a", label: "A", state: "pending" },
      { id: "b", label: "B", state: "pending" },
    ]);
    expect(outlineChangeSummary(diffOutlineSteps(before, addedOnly))).toBeNull();
    const mixed = outline("x", [{ id: "a", label: "A", state: "blocked" }]);
    expect(outlineChangeSummary(diffOutlineSteps(before, mixed))).toBeNull();
    expect(outlineChangeSummary([])).toBeNull();
  });
});

describe("outline runner decisions and worker handoff", () => {
  const active = (runner?: Step["runner"]): Outline => outline("Ship it", [
    {
      id: "build",
      label: "Build",
      state: "active",
      ...(runner ? { runner } : {}),
      children: [{ id: "tests", label: "Tests", state: "pending", detail: "run all" }],
    },
  ]);
  const pi = { harness: "pi" as const, provider: "glm" as const, model: "glm-5.3-flash" };

  it("allows auto/no outline, restricts self and thread, and pins an exact harness route", () => {
    expect(runnerGate(null, { kind: "thread" })).toMatchObject({ ok: true, active: null });
    expect(runnerGate(active("auto"), { kind: "harness", harness: "pi" })).toMatchObject({ ok: true, route: null });
    expect(runnerGate(active("self"), { kind: "thread" })).toMatchObject({ ok: false, message: expect.stringContaining("self") });
    expect(runnerGate(active("thread"), { kind: "thread" })).toMatchObject({ ok: true });
    expect(runnerGate(active("thread"), { kind: "harness", harness: "pi" })).toMatchObject({ ok: false, message: expect.stringContaining("thread") });
    expect(runnerGate(active(pi), { kind: "thread" })).toMatchObject({ ok: false, message: expect.stringContaining("pinned") });
    expect(runnerGate(active(pi), { kind: "harness", harness: "claude" })).toMatchObject({ ok: false, message: expect.stringContaining("different") });
    expect(runnerGate(active(pi), { kind: "harness", harness: "pi" })).toMatchObject({ ok: true, route: pi });
  });

  it("splitOutlineContext peels the outline block wherever it sits", () => {
    const wrapped = prependOutlineHandoff("fix the bug", active("thread")).task;
    const split = splitOutlineContext(wrapped)!;
    expect(split.context).toBe("Goal: Ship it\n- Build [active]\n  - Tests [pending] — run all");
    expect(split.rest).toBe("fix the bug");
    const outline = active("auto");
    const trailing = `do the work\n\n${renderOutlineHandoff(outline, outline.steps[0]!)}`;
    const after = splitOutlineContext(trailing)!;
    expect(after.rest).toBe("do the work");
    expect(splitOutlineContext("just a message")).toBeNull();
  });

  it("prepends the goal and active subtree compactly", () => {
    const wrapped = prependOutlineHandoff("Do the work", active("thread"));
    expect(wrapped.step).toBe("Build");
    expect(wrapped.task).toBe(
      "[outline context]\nGoal: Ship it\n- Build [active]\n  - Tests [pending] — run all\n[/outline context]\n\nDo the work",
    );
  });
});

describe("the thread phase reads the outline (0064)", () => {
  it("phaseFromMessages reads both the plan events and the outline", () => {
    const phase = phaseFromMessages([
      {
        id: "a",
        role: "assistant",
        parts: [{ type: "tool-update_outline", toolCallId: "s", state: "output-available", input: {}, output: { ok: true, version: 1, outline: implement, proposed: false, next: "ok" } }],
      } as never,
    ]);
    expect(phase?.label).toBe("Implement · 2/3");
  });
});

describe("0064 outline reviews (store + cores)", () => {
  let n = 0;
  const conv = () => {
    const id = `c_outline_${++n}_${Math.random().toString(36).slice(2, 6)}`;
    ensureConversation(db(), id, "p_outline");
    return id;
  };

  db().insert(projects).values({ id: "p_outline", name: "Outline", createdAt: 0 }).onConflictDoNothing().run();

  const persistProposal = (id: string, callId: string, value: Outline) => {
    const proposed = updateOutline(id, callId, { ...value, propose: true });
    appendMessages(db(), id, [{ id: `${id}_${callId}`, role: "tool", text: "", modelMessage: resultRow(callId, proposed) }]);
    return proposed;
  };

  const editDeps = (wakes: unknown[]) => ({
    wake: async (...args: unknown[]) => {
      wakes.push(args);
    },
  });

  it("a plain rewrite (no propose) never opens a review — it returns synchronously, never suspending", () => {
    const id = conv();
    const res = updateOutline(id, "t1", { goal: "Ship it", steps: [{ id: "a", label: "A", state: "active" }] });
    expect(res).toMatchObject({ ok: true, version: 1, proposed: false });
    expect(outlineState(db(), id).kind).toBe("none");
    expect(listPendingInputs(db(), id)).toEqual([]);
  });

  it("propose: true opens a review (never suspends); a newer proposal supersedes it; versions count prior calls", () => {
    const id = conv();
    const v1 = updateOutline(id, "t1", { goal: "Ship it", steps: [{ id: "a", label: "A", state: "active" }], propose: true });
    expect(v1).toMatchObject({ ok: true, version: 1, proposed: true });
    expect(outlineState(db(), id)).toMatchObject({ kind: "review", row: { id: "t1" } });

    const v2 = updateOutline(id, "t2", { goal: "Ship it", steps: [{ id: "a", label: "A", state: "done" }], propose: true }, [resultRow("t1", v1)]);
    expect(v2).toMatchObject({ ok: true, version: 2, proposed: true });
    expect(listPendingInputs(db(), id).map((p) => p.id)).toEqual(["t2"]);
    expect(getOutlineRow(db(), "t1")?.answer).toMatchObject({ superseded: true });
  });

  it("counts a persisted result that is also live only once", () => {
    const id = conv();
    const v1 = updateOutline(id, "dedupe1", {
      goal: "Ship it",
      steps: [{ id: "a", label: "A", state: "active" }],
      propose: true,
    });
    const row = resultRow("dedupe1", v1);
    appendMessages(db(), id, [{ id: `${id}_dedupe1`, role: "tool", text: "", modelMessage: row }]);

    const v2 = updateOutline(
      id,
      "dedupe2",
      { goal: "Ship it", steps: [{ id: "a", label: "A", state: "done" }] },
      [row],
    );
    expect(v2).toMatchObject({ ok: true, version: 2 });
  });

  it("a plain rewrite leaves an earlier proposed review open", () => {
    const id = conv();
    const proposed = updateOutline(id, "open1", {
      goal: "Ship it",
      steps: [{ id: "a", label: "A", state: "active" }],
      propose: true,
    });
    const row = resultRow("open1", proposed);
    appendMessages(db(), id, [{ id: `${id}_open1`, role: "tool", text: "", modelMessage: row }]);

    const plain = updateOutline(
      id,
      "plain2",
      { goal: "Ship it", steps: [{ id: "a", label: "A", state: "done" }] },
      [row],
    );
    expect(plain).toMatchObject({ ok: true, version: 2, proposed: false });
    expect(outlineState(db(), id)).toMatchObject({ kind: "review", row: { id: "open1" } });
    expect(deriveOutline([row, resultRow("plain2", plain)]).review).toMatchObject({ version: 1 });
  });

  it("the card approves the open review once and wakes; stale or repeated approvals are refused", async () => {
    const id = conv();
    const v3 = updateOutline(id, "t3", { goal: "x", steps: [{ id: "a", label: "A", state: "active" }], propose: true });
    const live: ModelMessage[] = [
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "t3", toolName: "update_outline", output: { type: "json", value: v3 as never } }],
      } as ModelMessage,
    ];
    updateOutline(id, "t4", { goal: "x", steps: [{ id: "a", label: "A", state: "done" }], propose: true }, live);

    const woke: unknown[] = [];
    const deps: ApproveOutlineDeps = {
      resume: async () => {
        throw new Error("no accept_outline waiting");
      },
      wake: async (...args) => {
        woke.push(args);
      },
    };
    expect(await approveOutline("t3", undefined, deps)).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("v2") });
    expect(await approveOutline("nope", undefined, deps)).toMatchObject({ ok: false, status: 404 });
    expect(await approveOutline("t4", "go", deps)).toEqual({ ok: true, version: 2, delivered: "wake" });
    expect(woke).toEqual([[id, 2, "t4", "go"]]);
    expect(outlineState(db(), id)).toMatchObject({ kind: "approved", row: { id: "t4" } });
    expect(await approveOutline("t4", undefined, deps)).toMatchObject({ ok: false, status: 409, error: "this outline is already approved" });
    expect(woke).toHaveLength(1);
  });

  it("the card's approve answers a waiting accept_outline instead of waking", async () => {
    const id = conv();
    updateOutline(id, "t5", { goal: "x", steps: [{ id: "a", label: "A", state: "active" }], propose: true });
    const preview = acceptOutlinePreview(id);
    expect(preview).toMatchObject({ ok: true, rowId: "t5" });
    if (!preview.ok) throw new Error("unreachable");

    const resumed: string[] = [];
    const { recordPendingInput } = await import("../db/chat");
    recordPendingInput(db(), { id: "acc1", conversationId: id, kind: "approval", question: preview.summary, card: preview.card });
    const res = await approveOutline("t5", undefined, {
      resume: async (token) => {
        resumed.push(token);
      },
      wake: async () => {
        throw new Error("must not wake");
      },
    });
    expect(res).toEqual({ ok: true, version: 1, delivered: "accept_outline" });
    expect(resumed).toEqual(["acc1"]);
    expect(acceptOutlineApproved("t5")).toMatchObject({ approved: true, version: 1 });
  });

  it("accept_outline refuses without an open review", () => {
    const id = conv();
    expect(acceptOutlinePreview(id)).toMatchObject({ ok: false, code: "no-review" });
  });

  it("owner edits reject a stale base and supersede the open review", async () => {
    const id = conv();
    persistProposal(id, "edit_base", outline("Ship", [{ id: "a", label: "A", state: "active" }]));
    const wakes: unknown[] = [];
    expect(await editOutline({
      conversationId: id,
      baseVersion: 0,
      outline: outline("Ship", [{ id: "a", label: "B", state: "active" }]),
    }, editDeps(wakes))).toMatchObject({ ok: false, status: 400, code: "invalid-version" });

    const edited = await editOutline({
      conversationId: id,
      baseVersion: 1,
      outline: outline("Ship", [{ id: "a", label: "B", state: "active" }]),
    }, editDeps(wakes));
    expect(edited).toMatchObject({ ok: true, version: 2, approved: false, woke: false });
    expect(getOutlineRow(db(), "edit_base")?.answer).toMatchObject({ superseded: true });
    expect(outlineState(db(), id)).toMatchObject({ kind: "review", row: { card: { version: 2 } } });
    expect(wakes).toEqual([]);
    expect(await editOutline({
      conversationId: id,
      baseVersion: 1,
      outline: outline("Ship", [{ id: "a", label: "C", state: "active" }]),
    }, editDeps(wakes))).toMatchObject({ ok: false, status: 409, code: "stale" });
    expect(updateOutline(id, "after_owner_edit", {
      goal: "Ship",
      steps: [{ id: "a", label: "Agent rewrite", state: "active" }],
    })).toMatchObject({ ok: true, version: 3 });
  });

  it("edit plus approve appends one edit snapshot and wakes once", async () => {
    const id = conv();
    persistProposal(id, "approve_edit_base", outline("Ship", [{ id: "a", label: "A", state: "active" }]));
    const wakes: unknown[] = [];
    const result = await editOutline({
      conversationId: id,
      baseVersion: 1,
      outline: outline("Ship", [{ id: "a", label: "Renamed", state: "active" }]),
      approve: true,
      note: "go",
    }, editDeps(wakes));
    expect(result).toMatchObject({ ok: true, version: 2, approved: true, woke: true });
    expect(wakes).toHaveLength(1);
    expect(outlineState(db(), id)).toMatchObject({ kind: "approved", row: { card: { version: 2 } } });
    expect(deriveOutline(listModelMessages(db(), id)).current).toMatchObject({ version: 2, outline: { steps: [{ label: "Renamed" }] } });
  });

  it("with no review ever opened, an edit is still runner-only (matching the UI)", async () => {
    const id = conv();
    // A plain (never-proposed) rewrite: outlineState is kind "none".
    const plain = updateOutline(id, "no_review_base", { goal: "Ship", steps: [{ id: "a", label: "A", state: "pending", runner: "auto" }] });
    appendMessages(db(), id, [{ id: `${id}_no_review_base`, role: "tool", text: "", modelMessage: resultRow("no_review_base", plain) }]);
    const wakes: unknown[] = [];
    expect(await editOutline({
      conversationId: id,
      baseVersion: 1,
      outline: outline("Changed", [{ id: "a", label: "A", state: "pending", runner: "auto" }]),
    }, editDeps(wakes))).toMatchObject({ ok: false, status: 409, code: "approved" });
    // A runner-only edit still goes through and wakes.
    expect(await editOutline({
      conversationId: id,
      baseVersion: 1,
      outline: outline("Ship", [{ id: "a", label: "A", state: "pending", runner: "self" }]),
    }, editDeps(wakes))).toMatchObject({ ok: true, version: 2, woke: true });
    expect(wakes).toHaveLength(1);
  });

  it("after approval only a pending top-level runner edit is accepted and wakes", async () => {
    const id = conv();
    persistProposal(id, "runner_edit_base", outline("Ship", [{ id: "a", label: "A", state: "pending", runner: "auto" }]));
    const firstWakes: unknown[] = [];
    await editOutline({
      conversationId: id,
      baseVersion: 1,
      outline: outline("Ship", [{ id: "a", label: "A", state: "pending", runner: "thread" }]),
      approve: true,
    }, editDeps(firstWakes));
    const wakes: unknown[] = [];
    expect(await editOutline({
      conversationId: id,
      baseVersion: 2,
      outline: outline("Ship", [{ id: "a", label: "A", state: "pending", runner: "self" }]),
    }, editDeps(wakes))).toMatchObject({ ok: true, version: 3, woke: true });
    expect(wakes).toHaveLength(1);
    expect(await editOutline({
      conversationId: id,
      baseVersion: 3,
      outline: outline("Changed", [{ id: "a", label: "A", state: "pending", runner: "self" }]),
    }, editDeps(wakes))).toMatchObject({ ok: false, code: "approved" });
  });

  it("refuses an edited runner forbidden by project restrictions", async () => {
    const projectId = `p_outline_restricted_${Math.random().toString(36).slice(2, 7)}`;
    db().insert(projects).values({
      id: projectId,
      name: "Restricted",
      allowedHarnesses: JSON.stringify(["pi"]),
      createdAt: 0,
    }).run();
    const id = `c_outline_restricted_${Math.random().toString(36).slice(2, 7)}`;
    ensureConversation(db(), id, projectId);
    persistProposal(id, "restricted_base", outline("Ship", [{ id: "a", label: "A", state: "pending" }]));
    expect(await editOutline({
      conversationId: id,
      baseVersion: 1,
      outline: outline("Ship", [{ id: "a", label: "A", state: "pending", runner: { harness: "claude" } }]),
    }, editDeps([]))).toMatchObject({ ok: false, status: 400, code: "invalid-runner", error: expect.stringContaining("does not allow") });
  });
});

describe("isOutline", () => {
  it("accepts a valid tree and rejects a step missing an id", () => {
    expect(isOutline(implement)).toBe(true);
    expect(isOutline({ goal: "x", steps: [{ label: "A", state: "active" }] })).toBe(false);
  });
});
