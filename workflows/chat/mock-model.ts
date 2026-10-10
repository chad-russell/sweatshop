import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";

/**
 * 0010 spike mock LLM — the repo's first agent-behavior mock (AGENTS.md:
 * tests never wait on a real model call). Selected by the turn workflow
 * when SWEATSHOP_CHAT_MOCK names a script and NODE_ENV=test, so it can
 * never fire in dev or production.
 *
 * Every script is STATELESS — keyed on prompt shape, not a call counter:
 * the workflow serializes the model across step boundaries, so instance
 * state resets between slices. (Real models are stateless the same way.)
 * SWEATSHOP_CHAT_MOCK ("plain" | "approve" | "question" | "steer" |
 * "hang" | "edit-machine" | "create-machine" | "create-pr" | "viewing" | "playbook" | "loop") is read at call time so a test file can
 * switch scripts between turns.
 *
 * The "steer" script never touches the database itself: workflow context
 * (where doStream runs) forbids Node APIs. The TEST enqueues the steer
 * row before starting the turn; slice 1's tool call forces a second
 * slice, and the drain between slices must inject the row first.
 */

const NO_USAGE = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: undefined, reasoning: undefined },
  totalTokens: 2,
};

function textPart(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: NO_USAGE },
  ];
}

function toolCallPart(
  toolCallId: string,
  toolName: string,
  input: unknown,
): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: "ti", toolName },
    { type: "tool-input-end", id: "ti" },
    {
      type: "tool-call",
      toolCallId,
      toolName,
      input: JSON.stringify(input),
    },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: NO_USAGE },
  ];
}

function result(parts: LanguageModelV4StreamPart[]) {
  return {
    stream: new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
  };
}

type PromptMessage = LanguageModelV4CallOptions["prompt"][number];

function messageText(message: PromptMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

function userTexts(prompt: LanguageModelV4CallOptions["prompt"]): string[] {
  return prompt
    .filter((message) => message.role === "user")
    .map(messageText);
}

export function scriptedChatModel(): LanguageModel {
  return new MockLanguageModelV4({
    provider: "sweatshop-mock",
    modelId: "mock-chat",
    doStream: async (options) => {
      const script = process.env.SWEATSHOP_CHAT_MOCK ?? "plain";
      // Script position derives from the prompt (stateless): a tool
      // message present means this is the slice after a tool round-trip.
      const sawToolResult = options.prompt.some((m) => m.role === "tool");

      if (script === "hang") {
        await new Promise<never>(() => {});
      }

      if (script === "approve" || script === "question") {
        if (!sawToolResult) {
          return result(
            toolCallPart(
              "call_ask_chad_1",
              "ask_chad",
              script === "question"
                ? { kind: "question", question: "Which database should we use?" }
                : { kind: "approval", question: "Proceed with the spike?" },
            ),
          );
        }
        // Echo the tool result back so the test can see it round-tripped.
        const toolMessage = options.prompt.find((m) => m.role === "tool");
        return result(textPart(`mock-after:${toolMessage ? messageText(toolMessage) : "no-tool-message"}`));
      }

      // 0037: bind a playbook mid-thread; later turns see it in the
      // system prompt ("mock-playbook:<in-system>").
      if (script === "playbook") {
        const system = options.prompt.find((m) => m.role === "system");
        const inSystem = system ? messageText(system).includes("# Playbook: Ship") : false;
        if (!sawToolResult && !inSystem) {
          return result(toolCallPart("call_playbook_1", "use_playbook", { id: "ship" }));
        }
        return result(textPart(`mock-playbook:${inSystem}`));
      }

      // 0037: a turn that never stops calling tools — exhausts its budget.
      if (script === "loop") {
        const n = options.prompt.filter((m) => m.role === "tool").length;
        return result(toolCallPart(`call_loop_${n}`, "note", { note: `loop ${n}` }));
      }

      if (script === "steer") {
        if (!sawToolResult) {
          return result(
            toolCallPart("call_note_1", "note", { note: "slice one" }),
          );
        }
        const steered = userTexts(options.prompt).includes("STEER_MARKER");
        return result(
          textPart(steered ? "mock-steer-saw:STEER_MARKER" : "mock-steer-missed"),
        );
      }

      // 0015: a scripted edit_machine round trip — the machine row must
      // change through the ordinary chat runtime.
      if (script === "edit-machine") {
        if (!sawToolResult) {
          return result(
            toolCallPart("call_edit_1", "edit_machine", {
              id: "m-mock-edit",
              baseVersion: 1,
              ops: [
                { op: "add_stage", kind: "human", title: "Approve" },
                { op: "connect", source: "draft", target: "approve", when: "Ready" },
              ],
            }),
          );
        }
        const toolMessage = options.prompt.find((m) => m.role === "tool");
        return result(textPart(`mock-after:${toolMessage ? messageText(toolMessage) : "no-tool-message"}`));
      }

      // create_machine is approval-gated: the call suspends on Chad's
      // answer (token = the tool call id) before anything is written.
      if (script === "create-machine") {
        if (!sawToolResult) {
          return result(
            // The call id doubles as the approval token and the pending
            // row's key — derive it from the machine id so passes differ.
            toolCallPart(`call_create_${process.env.SWEATSHOP_CHAT_MOCK_MACHINE ?? "m-mock-create"}`, "create_machine", {
              id: process.env.SWEATSHOP_CHAT_MOCK_MACHINE ?? "m-mock-create",
              name: "Mock create",
              definition: {
                workspace: "none",
                start: "draft",
                stages: { draft: { kind: "agent", title: "Draft", instructions: "d", next: [] } },
              },
            }),
          );
        }
        const toolMessage = options.prompt.find((m) => m.role === "tool");
        return result(textPart(`mock-after:${toolMessage ? messageText(toolMessage) : "no-tool-message"}`));
      }

      // 0034 Phase A: a scripted create_pr round trip — the call must
      // suspend on Chad's approval (token = the tool call id) before the
      // host is ever hit.
      if (script === "create-pr") {
        if (!sawToolResult) {
          return result(
            toolCallPart("call_pr_1", "create_pr", {
              repo: "r",
              head: "feat/trial",
              title: "Trial PR",
            }),
          );
        }
        const toolMessage = options.prompt.find((m) => m.role === "tool");
        return result(textPart(`mock-after:${toolMessage ? messageText(toolMessage) : "no-tool-message"}`));
      }

      // 0015: report how many "[viewing]" notes the model was shown (the
      // current send's + injected history ones). Notes are user-role
      // messages that START with the prefix; the instructions merely
      // mention it mid-text, and real user text never starts with it.
      if (script === "viewing") {
        const notes = options.prompt.filter(
          (m) => m.role === "user" && messageText(m).startsWith("[viewing]"),
        ).length;
        return result(textPart(`mock-viewing:${notes}`));
      }

      // plain: reply with the user-message count — proves the turn loaded
      // the conversation's full persisted history.
      return result(textPart(`mock-reply:${userTexts(options.prompt).length}`));
    },
  });
}
