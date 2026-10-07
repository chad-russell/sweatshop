import { WorkflowAgent, type ModelCallStreamPart } from "@ai-sdk/workflow";
import type { ModelMessage } from "ai";
import { isStepCount } from "ai";
import { getWritable } from "workflow";
import { viewingNote, type ViewingContext } from "../../lib/page-context";
import { buildTurnModel } from "./model";
import { buildChatTools } from "./tools";
import {
  drainSteerStep,
  finishTurnStream,
  loadTurnHistory,
  maybeTitleStep,
  persistTurn,
  recordUserMessage,
  resolveTurnRouteStep,
} from "./steps";

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
  /** 0013: the conversation has a sandbox binding (pending or bound);
   *  false omits the sandboxed tools. */
  hasSandbox?: boolean;
  /** Whether the conversation is bound to a project (pi/claude). */
  hasProject?: boolean;
  /** 0015: the page the send came from — "this" for the agent. */
  viewing?: ViewingContext;
  /** 0022: this send is a wake (a child settled) — marks the user row
   *  so the transcript renders it as a chip, never Chad's own words. */
  runEvent?: import("../../db/chat").RunEventMeta;
}

const INSTRUCTIONS = `You are sweatshop's agent (new chat runtime spike). Be concise.
Use the ask_chad tool when a decision or approval is genuinely Chad's to make.
When a message carries a "[viewing]" note, "this"/"it" refers to what it names; use its ids with your tools (get_machine, inspect) instead of asking.
If Chad asks for something that needs a tool you were not given (pi, claude, and bash exist only in project chats with a sandbox), say so and tell him to start a project chat — never improvise a substitute (e.g. a new machine, or a different model standing in for the harness he asked for).`;

export async function chatTurn(input: ChatTurnInput) {
  "use workflow";
  const { conversationId, userText } = input;

  const history = await loadTurnHistory(conversationId);
  await recordUserMessage(conversationId, userText, history.length, input.viewing, input.runEvent);

  // 0021: resolved per turn (a picker change or a /settings swap takes
  // effect on the next turn); recorded on the turn's assistant row.
  const resolved = await resolveTurnRouteStep(conversationId);
  const model = await buildTurnModel(resolved.route);
  const writable = getWritable<ModelCallStreamPart>();
  const agent = new WorkflowAgent({
    model,
    instructions: INSTRUCTIONS,
    tools: buildChatTools(conversationId, {
      hasSandbox: input.hasSandbox ?? true,
      hasProject: input.hasProject ?? true,
    }),
  });

  // The current send's viewing note: a user-role message right before
  // the send (the agent forbids system messages in `messages`), model
  // input only — it is persisted as metadata on the user row above and
  // rebuilt by listTurnMessages; persistTurn's skip keeps it out.
  let messages: ModelMessage[] = [
    ...history,
    ...(input.viewing ? [{ role: "user" as const, content: viewingNote(input.viewing) }] : []),
    { role: "user", content: userText },
  ];
  let finishReason: string = "stop";
  let stored = 0;
  // One durable stream per TURN, not per slice: every slice leaves it
  // open and unfinished; finishTurnStream ends it exactly once — also
  // when a slice throws, so a reconnected browser is never left hanging.
  // It ends AFTER persistTurn: a browser that sees `finish` may reload
  // the conversation from sqlite (the fresh page's /c adoption does) and
  // must find the whole turn there.
  try {
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
        preventClose: true,
        sendFinish: false,
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
    // user message) plus the injected note, which sits right before it —
    // persistTurn stores only the new tail.
    const skip = history.length + (input.viewing ? 1 : 0) + 1;
    stored = await persistTurn(conversationId, messages, skip, resolved);
  } finally {
    await finishTurnStream(writable);
  }
  // Generated titles (0007) — skipped under the scripted mock so tests
  // never wait on (or pay for) a real title call.
  if (!(process.env.SWEATSHOP_CHAT_MOCK && process.env.NODE_ENV === "test")) {
    await maybeTitleStep(conversationId);
  }
  return { finishReason, persisted: stored };
}

/** The agent prepends its instructions as a system message on every
 *  stream call; drop exactly that one so re-feeding and persisting see
 *  only conversation messages. (Injected viewing notes are mid-list —
 *  they must survive the loop — and persistTurn skips system rows.) */
function stripLeadingSystem(messages: ModelMessage[]): ModelMessage[] {
  return messages[0]?.role === "system" ? messages.slice(1) : messages;
}
