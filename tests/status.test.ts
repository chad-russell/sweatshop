import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { derivePhase, phaseFromMessages } from "../lib/plan";
import {
  activeStepHistory,
  deriveStatus,
  renderThreadStateNote,
  skillsUsed,
  statusChipLabel,
  type StatusSnapshot,
} from "../lib/status";
import { updateStatus } from "../lib/agent/tools/status";

function snap(steps: StatusSnapshot["steps"], note?: string): StatusSnapshot {
  return note ? { ok: true, steps, note } : { ok: true, steps };
}

const implement = snap([
  { label: "Plan", state: "done" },
  {
    label: "Implement",
    state: "active",
    children: [
      { label: "column", state: "done" },
      { label: "card", state: "done" },
      { label: "tests", state: "pending" },
    ],
  },
  { label: "Ship", state: "pending" },
]);

describe("updateStatus", () => {
  it("normalizes a rewrite and drops a blank note", () => {
    expect(updateStatus({ steps: [{ label: "  Plan  ", state: "active", detail: "  " }], note: "  " })).toEqual({
      ok: true,
      steps: [{ label: "Plan", state: "active" }],
    });
  });

  it("refuses an empty list, a bad state, and grandchildren", () => {
    expect(updateStatus({ steps: [] })).toMatchObject({ ok: false, code: "invalid" });
    expect(updateStatus({ steps: [{ label: "Plan", state: "later" }] })).toMatchObject({ ok: false });
    expect(
      updateStatus({
        steps: [{ label: "Plan", state: "active", children: [{ label: "a", state: "pending", children: [{ label: "b", state: "done" }] }] }],
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("statusChipLabel", () => {
  it("uses the active step's children as the fraction", () => {
    expect(statusChipLabel(implement)).toEqual({ label: "Implement · 2/3", tone: "running" });
  });

  it("counts top-level steps when the active step has no children, and skipped is not done", () => {
    const snapshot = snap([
      { label: "Plan", state: "done" },
      { label: "Implement", state: "active" },
      { label: "Review", state: "skipped" },
    ]);
    expect(statusChipLabel(snapshot)).toEqual({ label: "Implement · 1/3", tone: "running" });
  });

  it("a blocked step wins over the fraction", () => {
    const snapshot = snap([
      { label: "Plan", state: "done" },
      { label: "Implement", state: "active", children: [{ label: "auth", state: "blocked" }] },
    ]);
    expect(statusChipLabel(snapshot)).toEqual({ label: "auth · needs you", tone: "warn" });
  });

  it("with no active step, names the last done step", () => {
    const snapshot = snap([
      { label: "Plan", state: "done" },
      { label: "Ship", state: "done" },
    ]);
    expect(statusChipLabel(snapshot)).toEqual({ label: "Ship · 2/2", tone: "ok" });
  });
});

describe("deriveStatus", () => {
  const ui = (output: StatusSnapshot) => ({
    role: "assistant",
    parts: [{ type: "tool-update_status", state: "output-available", output }],
  });

  it("the last rewrite is current and history keeps every one", () => {
    const first = snap([{ label: "Plan", state: "active" }]);
    const derived = deriveStatus([ui(first), ui(implement)]);
    expect(derived.history).toEqual([first, implement]);
    expect(derived.current).toEqual(implement);
    expect(derived.stale).toBe(false);
  });

  it("reads a model-message tool result", () => {
    const derived = deriveStatus([
      {
        role: "tool",
        content: [{ type: "tool-result", toolName: "update_status", output: { type: "json", value: implement } }],
      },
    ]);
    expect(derived.current).toEqual(implement);
  });

  it("a wake closed by a later user message, with no update_status, is stale", () => {
    const messages = [
      ui(implement),
      { role: "user", metadata: { runEvent: { kind: "thread" } }, parts: [{ type: "text", text: "[review finished] — /c/x" }] },
      { role: "assistant", parts: [{ type: "text", text: "noted" }] },
      { role: "user", parts: [{ type: "text", text: "ok" }] },
    ];
    expect(deriveStatus(messages).stale).toBe(true);
  });

  it("update_status after the wake clears stale, and a live tool call at the end does not mark it", () => {
    const cleared = [
      ui(implement),
      { role: "user", content: "[review finished] — /c/x" },
      ui(implement),
    ];
    expect(deriveStatus(cleared).stale).toBe(false);
    const live = [
      ui(implement),
      { role: "user", metadata: { runEvent: { kind: "harness" } }, parts: [{ type: "text", text: "wake" }] },
      { role: "assistant", parts: [{ type: "tool-bash", state: "input-available" }] },
    ];
    expect(deriveStatus(live).stale).toBe(false);
  });

  it("a budget continuation is not a wake", () => {
    const messages = [
      ui(implement),
      { role: "user", metadata: { runEvent: { kind: "budget" } }, parts: [{ type: "text", text: "[budget] continuing" }] },
      { role: "assistant", parts: [{ type: "text", text: "still going" }] },
      { role: "user", parts: [{ type: "text", text: "next" }] },
    ];
    expect(deriveStatus(messages).stale).toBe(false);
  });
});

describe("history, skills, and the thread-state note", () => {
  it("collapses consecutive active steps and lists skills in first-seen order", () => {
    const history = [
      snap([{ label: "Plan", state: "active" }]),
      snap([{ label: "Plan", state: "active" }]),
      snap([{ label: "Implement", state: "active" }]),
    ];
    expect(activeStepHistory(history)).toEqual(["Plan", "Implement"]);
    const messages = [
      { role: "user", metadata: { runEvent: { kind: "mode", id: "ticket" } }, parts: [] },
      { role: "assistant", parts: [{ type: "tool-use_skill", state: "output-available", output: { ok: true, id: "review" } }] },
      { role: "assistant", parts: [{ type: "tool-use_skill", state: "output-available", output: { ok: true, id: "ticket", mode: true } }] },
    ];
    expect(skillsUsed(messages)).toEqual(["ticket", "review"]);
  });

  it("renders the status, the stale flag, and the seed line", () => {
    const status = deriveStatus([]);
    expect(renderThreadStateNote(status, [{ name: "Plan" }, { name: "Ship" }])).toContain(
      "seed update_status from: Plan → Ship",
    );
    expect(renderThreadStateNote(status)).toBeNull();
    const current = deriveStatus([
      { role: "assistant", parts: [{ type: "tool-update_status", state: "output-available", output: implement }] },
    ]);
    const note = renderThreadStateNote(current);
    expect(note).toContain("Implement · 2/3");
    expect(note).toContain("if this changed, call update_status");
    expect(renderThreadStateNote({ ...current, stale: true })).toContain("(stale)");
  });
});

describe("derivePhase prefers PR and an open plan over status", () => {
  const status = deriveStatus([
    { role: "assistant", parts: [{ type: "tool-update_status", state: "output-available", output: implement }] },
  ]);

  it("status fills the chip only when no PR and no open review is waiting", () => {
    expect(derivePhase([], status)?.label).toBe("Implement · 2/3");
    expect(derivePhase([{ type: "plan", version: 2, status: "review", checklist: { done: 0, total: 1 } }], status)?.label).toBe(
      "Plan v2 · needs you",
    );
    expect(derivePhase([{ type: "pr-open", url: "http://x/pull/1" }], status)?.label).toBe("PR open");
    expect(derivePhase([{ type: "pr-open", url: "http://x/pull/1" }], { ...status, stale: true })?.stale).toBeUndefined();
    expect(derivePhase([], { ...status, stale: true })?.stale).toBe(true);
  });

  it("phaseFromMessages reads both the plan events and the status", () => {
    const phase = phaseFromMessages([
      {
        id: "a",
        role: "assistant",
        parts: [{ type: "tool-update_status", toolCallId: "s", state: "output-available", input: {}, output: implement }],
      } as UIMessage,
    ]);
    expect(phase?.label).toBe("Implement · 2/3");
  });
});
