import { describe, expect, it } from "vitest";
import {
  claimHarnessRun,
  countToolCalls,
  clipHarnessText,
  getActiveHarnessRun,
  getHarnessEvents,
  getHarnessRun,
  isHarnessKind,
  listHarnessRuns,
  recordHarnessEvent,
  recordHarnessRunEnd,
} from "../lib/harness-events";


describe("harness event store (0006)", () => {
  it("keeps events isolated per harness within one conversation", () => {
    recordHarnessEvent("wrun_h1", "pi", { kind: "start" });
    recordHarnessEvent("wrun_h1", "claude", { kind: "start" });
    recordHarnessEvent("wrun_h1", "claude", {
      kind: "tool-start",
      toolName: "bash",
    });

    const pi = getHarnessEvents("wrun_h1", "pi").events;
    const claude = getHarnessEvents("wrun_h1", "claude").events;
    expect(pi).toHaveLength(1);
    expect(claude).toHaveLength(2);
    expect(claude[1].toolName).toBe("bash");
  });

  it("round-trips toolCallId and tool-error rows", () => {
    recordHarnessEvent("wrun_h3", "pi", { kind: "tool-start", toolName: "write", toolCallId: "tc1" });
    recordHarnessEvent("wrun_h3", "pi", { kind: "tool-error", toolName: "write", toolCallId: "tc1", output: "boom" });
    const events = getHarnessEvents("wrun_h3", "pi").events;
    expect(events.map((e) => [e.kind, e.toolCallId])).toEqual([
      ["tool-start", "tc1"],
      ["tool-error", "tc1"],
    ]);
  });

  it("tail returns the newest events, oldest-first", () => {
    for (let i = 0; i < 6; i += 1) {
      recordHarnessEvent("wrun_h4", "pi", { kind: "step-end", text: `t${i}` });
    }
    const page = getHarnessEvents("wrun_h4", "pi", { limit: 3, tail: true });
    expect(page.events.map((e) => e.text)).toEqual(["t3", "t4", "t5"]);
  });

  it("pages events with an id cursor", () => {
    for (let i = 0; i < 7; i += 1) {
      recordHarnessEvent("wrun_h2", "pi", { kind: "step-start" });
    }
    const first = getHarnessEvents("wrun_h2", "pi", { limit: 3 });
    expect(first.events).toHaveLength(3);
    expect(first.cursor).toBe(first.events[2].id);

    const rest = getHarnessEvents("wrun_h2", "pi", {
      afterId: first.cursor!,
      limit: 100,
    });
    expect(rest.events).toHaveLength(4);
    expect(rest.cursor).toBeNull();
    expect(rest.events[0].id).toBe(first.cursor! + 1);
  });

  it("claims the one-run slot exclusively across harnesses", () => {
    expect(claimHarnessRun("wrun_h3", "claude")).toBe(true);
    expect(getActiveHarnessRun("wrun_h3")?.kind).toBe("claude");
    // The other harness (and a re-claim of the same one) is blocked
    // while the slot is held.
    expect(claimHarnessRun("wrun_h3", "pi")).toBe(false);
    expect(claimHarnessRun("wrun_h3", "claude")).toBe(false);

    recordHarnessRunEnd("wrun_h3", "claude", 4, "failed", "boom");
    const run = getHarnessRun("wrun_h3", "claude");
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("boom");
    expect(run?.toolCalls).toBe(4);
    expect(getActiveHarnessRun("wrun_h3")).toBeNull();

    // Slot is free again — same or other harness may claim it.
    expect(claimHarnessRun("wrun_h3", "pi")).toBe(true);
    expect(getActiveHarnessRun("wrun_h3")?.kind).toBe("pi");
    // Other conversations are unaffected.
    expect(claimHarnessRun("wrun_h3b", "claude")).toBe(true);
  });

  it("resets run counters and error when re-claiming after a failed run", () => {
    recordHarnessRunEnd("wrun_h4", "pi", 1, "failed", "earlier failure");
    expect(claimHarnessRun("wrun_h4", "pi")).toBe(true);
    const run = getHarnessRun("wrun_h4", "pi");
    expect(run?.status).toBe("running");
    expect(run?.error).toBeNull();
    expect(run?.toolCalls).toBe(0);
  });

  it("clips stored error text and lists latest run per harness", () => {
    const long = "x".repeat(600);
    recordHarnessRunEnd("wrun_h5", "claude", 0, "failed", long);
    const errorText = getHarnessRun("wrun_h5", "claude")?.error;
    expect(errorText?.length).toBeLessThanOrEqual(501);

    claimHarnessRun("wrun_h5", "pi");
    const runs = listHarnessRuns("wrun_h5");
    expect(runs.map((r) => r.kind).sort()).toEqual(["claude", "pi"]);
  });

  it("validates harness kinds", () => {
    expect(isHarnessKind("pi")).toBe(true);
    expect(isHarnessKind("claude")).toBe(true);
    expect(isHarnessKind("codex")).toBe(false);
  });

  it("clips event payloads through the shared helper", () => {
    const clipped = clipHarnessText("y".repeat(3000), 100);
    expect(clipped?.length).toBeLessThanOrEqual(101);
    expect(clipHarnessText(undefined)).toBeUndefined();
  });
});

describe("countToolCalls (machine-stage settle)", () => {
  it("counts a session's tool-start events, not the claim's zero", () => {
    claimHarnessRun("mr_cnt_0", "pi");
    for (let i = 0; i < 3; i++) {
      recordHarnessEvent("mr_cnt_0", "pi", { kind: "tool-start", toolName: "bash", input: "x" });
      recordHarnessEvent("mr_cnt_0", "pi", { kind: "tool-end", toolName: "bash", output: "y" });
    }
    recordHarnessEvent("mr_cnt_0", "pi", { kind: "step-end" });
    expect(countToolCalls("mr_cnt_0", "pi")).toBe(3);
    recordHarnessRunEnd("mr_cnt_0", "pi", countToolCalls("mr_cnt_0", "pi"), "completed");
    expect(getHarnessRun("mr_cnt_0", "pi")?.toolCalls).toBe(3);
  });
});
