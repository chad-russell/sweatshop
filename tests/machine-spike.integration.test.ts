import { describe, expect, it } from "vitest";

/**
 * 0009 machines spike — the two load-bearing claims, against REAL models:
 *
 *  1. Semantic agent steps: a HarnessAgent turn advanced one agent step
 *     per call (`runHarnessAgentStep` + `stopWhen: isStepCount(1)`),
 *     with the HarnessWorkflowState JSON round-tripped and the agent +
 *     session REBUILT between every step — exactly what a fresh
 *     `"use step"` invocation sees after a process restart.
 *  2. One run-owned container: a pi stage and a claude stage work in
 *     the SAME provisioned sandbox, each seeing the other's files.
 *
 * Not part of the normal gate (real model calls, real containers):
 *   MACHINE_SPIKE=1 npx vitest run tests/machine-spike.integration.test.ts
 * claude stage needs CLAUDE_CODE_OAUTH_TOKEN; pi needs ZAI_API_KEY.
 */
const run = process.env.MACHINE_SPIKE === "1" ? describe : describe.skip;

type State = import("@ai-sdk/workflow-harness").HarnessWorkflowState;

run("machines spike (0009)", () => {
  it(
    "pi then claude, step by step, in one container",
    async () => {
      process.env.SWEATSHOP_DB = "data/sweatshop.db";
      const { provisionProjectSandbox } = await import("../lib/sandboxes/provision");
      const { toNetworkSandboxSession } = await import("../lib/sandboxes/ai-sdk-adapter");
      const { HarnessAgent } = await import("@ai-sdk/harness/agent");
      const { createPi } = await import("@ai-sdk/harness-pi");
      const { createClaudeCode } = await import("@ai-sdk/harness-claude-code");
      const { createHarnessWorkflowState, runHarnessAgentStep } = await import(
        "@ai-sdk/workflow-harness"
      );
      const { isStepCount } = await import("ai");

      const sb = await provisionProjectSandbox("spike");
      const sandboxSession = toNetworkSandboxSession({
        id: sb.containerName,
        handle: { ref: sb.containerName, run: sb.run, spawn: sb.spawn },
        // Same default directory the basic session resolved via pwd.
        workDir: (await sb.run("pwd")).stdout.trim(),
      });
      console.log("CONTAINER", sb.containerName);

      // Fresh agent per call — a step never sees a cached in-memory agent.
      const buildPi = () =>
        new HarnessAgent({
          harness: createPi({
            providers: {
              "zai-glm": {
                name: "Z.AI GLM Coding Plan",
                baseUrl: "https://api.z.ai/api/anthropic",
                apiKey: process.env.ZAI_API_KEY ?? "",
                api: "anthropic",
              },
            },
            thinkingLevel: "low",
          }),
          id: "spike-machine-pi",
          model: "zai-glm/glm-5.3-flash",
          stopWhen: isStepCount(1),
        });

      // The bridge endpoint resolves through getPortEndpoint (0013).
      const buildClaude = async () => {
        return new HarnessAgent({
          harness: createClaudeCode({
            auth: "direct",
            port: 4000,
            env: { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "" },
          }),
          id: "spike-machine-claude",
          sandboxConfig: { workDir: "." },
          stopWhen: isStepCount(1),
        });
      };

      const sink = () =>
        new WritableStream<{ type: string }>({
          write() {
            /* UI chunks — the engine will forward these to the run stream */
          },
        });

      /** Drive one stage to completion, one semantic step per call. */
      async function stage(
        label: string,
        build: () => Promise<InstanceType<typeof HarnessAgent>> | InstanceType<typeof HarnessAgent>,
        sessionId: string,
        prompt: string,
      ) {
        let state: State = createHarnessWorkflowState({ sessionId, prompt });
        let steps = 0;
        do {
          const agent = await build();
          const next = await runHarnessAgentStep({
            agent: agent as never,
            state,
            sandboxSession: sandboxSession as never,
            writable: sink() as never,
          });
          // The durable boundary: only JSON crosses it.
          state = JSON.parse(JSON.stringify(next)) as State;
          steps += 1;
          console.log(`${label} step ${steps}: ${state.status}`);
        } while (state.status === "ready_for_next_step" && steps < 40);
        if (state.status === "failed") throw new Error(`${label}: ${state.error}`);
        expect(state.status).toBe("finished");
        return steps;
      }

      try {
        const piSteps = await stage(
          "pi",
          buildPi,
          "spike-run-pi-0",
          "In /workspace/scratch: create stage-one.txt containing exactly " +
            "'written by pi'. Then run `cat /workspace/scratch/stage-one.txt` " +
            "to verify it. Do not commit.",
        );
        expect(piSteps).toBeGreaterThan(1); // really stepped, not one blob

        const one = await sb.run("cat /workspace/scratch/stage-one.txt");
        expect(one.stdout).toContain("written by pi");

        if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
          const claudeSteps = await stage(
            "claude",
            buildClaude,
            "spike-run-claude-1",
            "In /workspace/scratch there is stage-one.txt from a previous " +
              "stage. Read it, then create stage-two.txt whose content is " +
              "'claude saw: ' followed by stage-one.txt's exact content. " +
              "Do not commit.",
          );
          console.log("claude steps", claudeSteps);
          const two = await sb.run("cat /workspace/scratch/stage-two.txt");
          console.log("STAGE TWO:", two.stdout.trim());
          expect(two.stdout).toContain("claude saw: written by pi");
        } else {
          console.log("claude stage skipped: CLAUDE_CODE_OAUTH_TOKEN unset");
        }
      } finally {
        await sb.remove();
      }
    },
    1_200_000,
  );
});
