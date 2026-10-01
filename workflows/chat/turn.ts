import { WorkflowAgent, type ModelCallStreamPart } from "@ai-sdk/workflow";
import type { ModelMessage } from "ai";
import { isStepCount } from "ai";
import { getWritable } from "workflow";
import { buildTurnModel } from "./model";
import { buildChatTools } from "./tools";
import { drainSteerStep, loadTurnHistory, maybeTitleStep, persistTurn, recordUserMessage } from "./steps";

/**
 * 0010 spike: one chat turn = one workflow run. The run loads the
 * conversation's persisted history from sqlite, streams the agent turn
 * into the run's durable stream, persists the new messages, and ends.
 * Resume-after-restart and stream reconnect are per-turn properties of
 * the Workflow SDK; our database — not a long-lived run — owns the
 * conversation (docs/0010: "one workflow run per turn").
 *
 * The agent runs one model step per slice (stopWhen: isStepCount(1)) so
 * the workflow BODY decides between slices — where calling steps is
 * legal. prepareStep cannot serve this role: its nested closure runs in
 * the agent's context, and step invocations from there never dispatch.
 * Steer messages queued against a live turn are drained before every
 * slice after the first and injected as user messages.
 */

const MAX_STEPS = 50;

export interface ChatTurnInput {
  conversationId: string;
  userText: string;
  /** Endpoint model id (resolveChatModel already applied). */
  modelId: string;
}

const INSTRUCTIONS = `You are sweatshop's agent (new chat runtime spike). Be concise.
Use the ask_chad tool when a decision or approval is genuinely Chad's to make.`;

export async function chatTurn(input: ChatTurnInput) {
  "use workflow";
  const { conversationId, userText, modelId } = input;

  const history = await loadTurnHistory(conversationId);
  await recordUserMessage(conversationId, userText, history.length);

  const model = await buildTurnModel(modelId);
  const writable = getWritable<ModelCallStreamPart>();
  const agent = new WorkflowAgent({
    model,
    instructions: INSTRUCTIONS,
    tools: buildChatTools(conversationId),
  });

  let messages: ModelMessage[] = [...history, { role: "user", content: userText }];
  let finishReason: string = "stop";
  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (step > 0) {
      const queued = await drainSteerStep(conversationId);
      if (queued.length > 0) {
        messages = [
          ...messages,
          ...queued.map((text) => ({ role: "user" as const, content: text })),
        ];
      }
    }

    const result = await agent.stream({
      messages,
      writable,
      stopWhen: isStepCount(1),
    });
    messages = stripLeadingSystem(result.messages);
    finishReason = result.finishReason;

    // The turn ends when the latest assistant message asks for no tools.
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    const wantsTools =
      lastAssistant != null &&
      Array.isArray(lastAssistant.content) &&
      lastAssistant.content.some((part) => part.type === "tool-call");
    if (!wantsTools) break;
  }

  // skip = everything already persisted (loaded history + this turn's
  // user message); persistTurn stores only the new tail.
  const skip = history.length + 1;
  const stored = await persistTurn(conversationId, messages, skip);
  // Generated titles (0007) — skipped under the scripted mock so tests
  // never wait on (or pay for) a real title call.
  if (!(process.env.SWEATSHOP_CHAT_MOCK && process.env.NODE_ENV === "test")) {
    await maybeTitleStep(conversationId);
  }
  return { finishReason, persisted: stored };
}

/** The agent prepends its instructions as a system message; drop the
 *  prefix so re-feeding and persisting see only conversation messages. */
function stripLeadingSystem(messages: ModelMessage[]): ModelMessage[] {
  let prefix = 0;
  while (prefix < messages.length && messages[prefix].role === "system") {
    prefix += 1;
  }
  return messages.slice(prefix);
}
