import { describe, expect, it } from "vitest";
import { activeStepHistory, deriveStatus, skillsUsed, type StatusSnapshot } from "../lib/status";

/**
 * 0064: `lib/status.ts` is legacy now — `update_outline` (lib/outline.ts)
 * replaced the live `update_status` tool, and lib/outline.ts owns the
 * current chip/note derivations (tests/outline.test.ts). What's left
 * here (`deriveStatus`, `findStep`, `activeStepHistory`, `skillsUsed`,
 * `lastLoadedModeId`) is read only by mode machinery
 * (lib/agent/mode-ids.ts, lib/chat/phase-handoff.ts,
 * components/mode-chip.tsx) ahead of its removal.
 */

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

describe("history and skills", () => {
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
});
