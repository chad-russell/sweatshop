import type { HarnessWorkflowState } from "@ai-sdk/workflow-harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import { harnessAdvanceStep } from "../workflows/chat/harness-step";

/** 0022/0038: mock lifecycle markers retain their shape across advance steps. */
const initialState: HarnessWorkflowState = {
  sessionId: "c_mock",
  prompt: "test task",
  status: "ready_for_next_step",
};

function advance(state = initialState) {
  return harnessAdvanceStep({
    callId: "hc_mock",
    conversationId: "c_mock",
    kind: "pi",
    route: { harness: "pi", provider: "glm", model: "mock" },
    state,
  });
}

afterEach(() => vi.unstubAllEnvs());

describe("harnessAdvanceStep: mock state", () => {
  it("fails with the same resume marker and zero totals", async () => {
    vi.stubEnv("SWEATSHOP_HARNESS_MOCK", "fail-resume");
    expect(await advance()).toEqual({
      state: {
        ...initialState,
        status: "failed",
        error: "harness turn emitted an error",
        resumeFrom: { mock: "resume-after-failure" },
      },
      text: "",
      toolCalls: 0,
      usage: null,
      totals: { usage: null, steps: 0, toolCalls: 0 },
    });
  });

  it("loops with an incrementing continuation marker and totals", async () => {
    vi.stubEnv("SWEATSHOP_HARNESS_MOCK", "loop");
    const first = await advance();
    const second = await advance(first.state);
    expect(second).toEqual({
      state: {
        ...initialState,
        mockStep: 2,
        continueFrom: { mock: "continue", step: 2 },
      },
      text: "mock-harness-step:2",
      toolCalls: 1,
      usage: null,
      totals: { usage: null, steps: 2, toolCalls: 2 },
    });
  });

  it("finishes after two steps, retaining the previous continuation marker", async () => {
    vi.stubEnv("SWEATSHOP_HARNESS_MOCK", "1");
    const first = await advance();
    expect(first.state).toEqual({
      ...initialState,
      mockStep: 1,
      continueFrom: { mock: "continue", step: 1 },
    });
    expect(await advance(first.state)).toEqual({
      state: { ...first.state, mockStep: 2, status: "finished" },
      text: "mock-harness-step:2",
      toolCalls: 1,
      usage: null,
      totals: { usage: null, steps: 2, toolCalls: 2 },
    });
  });
});
