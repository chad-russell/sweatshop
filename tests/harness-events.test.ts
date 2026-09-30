import { describe, expect, it } from "vitest";
import {
  clipHarnessText,
  getActiveHarnessRun,
  getHarnessEvents,
  getHarnessRun,
  isHarnessKind,
  listHarnessRuns,
  recordHarnessEvent,
  recordHarnessRunEnd,
  recordHarnessRunStart,
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

  it("tracks run status per harness, including failures", () => {
    recordHarnessRunStart("wrun_h3", "claude");
    expect(getActiveHarnessRun("wrun_h3")?.kind).toBe("claude");

    recordHarnessRunEnd("wrun_h3", "claude", 4, "failed", "boom");
    const run = getHarnessRun("wrun_h3", "claude");
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("boom");
    expect(run?.toolCalls).toBe(4);
    expect(getActiveHarnessRun("wrun_h3")).toBeNull();

    // Same conversation, other harness, independent row.
    expect(getHarnessRun("wrun_h3", "pi")).toBeNull();
    recordHarnessRunStart("wrun_h3", "pi");
    expect(getActiveHarnessRun("wrun_h3")?.kind).toBe("pi");
  });

  it("marks a restarted run running again and clears the error", () => {
    recordHarnessRunEnd("wrun_h4", "pi", 1, "failed", "earlier failure");
    recordHarnessRunStart("wrun_h4", "pi");
    const run = getHarnessRun("wrun_h4", "pi");
    expect(run?.status).toBe("running");
    expect(run?.error).toBeNull();
  });

  it("clips stored error text and lists latest run per harness", () => {
    const long = "x".repeat(600);
    recordHarnessRunEnd("wrun_h5", "claude", 0, "failed", long);
    const errorText = getHarnessRun("wrun_h5", "claude")?.error;
    expect(errorText?.length).toBeLessThanOrEqual(501);

    recordHarnessRunStart("wrun_h5", "pi");
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
