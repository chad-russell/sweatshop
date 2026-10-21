/**
 * Live-spike helper (0021): drive one harness turn to completion exactly
 * like the production steps do — runHarnessAgentStep over a
 * HarnessWorkflowState, one semantic step at a time, until the turn is
 * no longer ready_for_next_step. Returns the final state.
 */
export async function driveHarnessTurn(input: {
  agent: unknown;
  sandboxSession: unknown;
  sessionId: string;
  prompt: string;
  maxSteps?: number;
}): Promise<{ status: string; error?: string; steps: number }> {
  const { createHarnessWorkflowState, runHarnessAgentStep } = await import("@ai-sdk/workflow-harness");
  let state = createHarnessWorkflowState({ sessionId: input.sessionId, prompt: input.prompt });
  const sink = new WritableStream();
  let steps = 0;
  do {
    state = await runHarnessAgentStep({
      agent: input.agent as never,
      state,
      sandboxSession: input.sandboxSession as never,
      writable: sink as never,
    });
    steps += 1;
  } while (state.status === "ready_for_next_step" && steps < (input.maxSteps ?? 100));
  return { status: state.status, error: (state as { error?: string }).error, steps };
}
