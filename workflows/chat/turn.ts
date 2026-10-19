import { WorkflowAgent, type ModelCallStreamPart } from "@ai-sdk/workflow";
import type { ModelMessage } from "ai";
import { isStepCount } from "ai";
import { getWritable } from "workflow";
import { viewingNote, type ViewingContext } from "../../lib/page-context";
import { addUsage, readSliceUsage, type UsageCounts } from "../../lib/usage/pricing";
import { buildInstructions } from "./instructions";
import { buildTurnModel } from "./model";
import { buildChatTools } from "./tools";
import {
  continueAfterBudgetStep,
  drainSteerStep,
  finishTurnStream,
  loadRepoDocsStep,
  loadSkillStep,
  loadTurnHistory,
  maybeTitleStep,
  persistTurn,
  recordUsageStep,
  recordUserMessage,
  resolveTurnRouteStep,
  wakeParentStep,
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
/** 0037/0039: a thread-skill thread works unattended — harness-stage parity. */
const THREAD_SKILL_MAX_STEPS = 400;

/** Pulled out of the workflow body so the budget choice is unit-testable
 *  without driving a turn: a skill or a start_thread child (0040 phase 3)
 *  gets the thread budget (400, or the test override), everyone else
 *  gets the plain 50 — never overridable (skillMaxSteps is test-only and
 *  only meaningful on the thread budget). */
export function resolveMaxSteps(hasSkillOrParent: boolean, skillMaxSteps?: number): number {
  return hasSkillOrParent ? (skillMaxSteps ?? THREAD_SKILL_MAX_STEPS) : MAX_STEPS;
}

export interface ChatTurnInput {
  conversationId: string;
  userText: string;
  /** 0042: ids of uploaded images riding this send (claimed on record). */
  attachments?: string[];
  /** 0013: the conversation has a sandbox binding (pending or bound);
   *  false omits the sandboxed tools. */
  hasSandbox?: boolean;
  /** Whether the conversation is bound to a project (pi/claude). */
  hasProject?: boolean;
  /** 0043: the project's host allow-list — non-empty adds the exec tool. */
  hosts?: { name: string; address: string; user: string; apiBase: string | null }[];
  /** 0040 phase 3: a start_thread child (parent_conversation_id set) —
   *  gets the thread step budget (400) even with no skill, so a
   *  follow-up thread cannot run out at the plain-chat 50. */
  hasParent?: boolean;
  /** 0015: the page the send came from — "this" for the agent. */
  viewing?: ViewingContext;
  /** 0022: this send is a wake (a child settled) — marks the user row
   *  so the transcript renders it as a chip, never Chad's own words. */
  runEvent?: import("../../db/chat").RunEventMeta;
  /** Tests only: override the thread-skill step budget. */
  skillMaxSteps?: number;
}

export async function chatTurn(input: ChatTurnInput) {
  "use workflow";
  const { conversationId, userText } = input;

  const history = await loadTurnHistory(conversationId);
  const userContent = await recordUserMessage(
    conversationId,
    userText,
    history.length,
    input.viewing,
    input.runEvent,
    input.attachments,
  );

  // 0021: resolved per turn (a picker change or a /settings swap takes
  // effect on the next turn); recorded on the turn's assistant row.
  const resolved = await resolveTurnRouteStep(conversationId);
  const model = await buildTurnModel(resolved.route);
  const writable = getWritable<ModelCallStreamPart>();
  // 0039: a thread running a skill gets its runbook in the
  // instructions and the background budget.
  const skill = await loadSkillStep(conversationId);
  // 0040 phase 3: a child thread gets the background budget too, even
  // with no skill bound — the budget CONTINUATION below stays skill-only
  // (an un-skilled child that runs out just reports it, never re-fires
  // itself unattended).
  const maxSteps = resolveMaxSteps(Boolean(skill) || Boolean(input.hasParent), input.skillMaxSteps);
  // Live testing showed none of pi/claude/cursor/codex, nor this agent, ever
  // read a project repo's AGENTS.md on their own — this appendix is the
  // top-level agent's fix (setupProjectWorkspace's work-root doc is the
  // harnesses'). Only a project conversation can have repo docs at all,
  // so plain chats skip the step call entirely (no extra round trip on
  // every turn for something that can never apply).
  const repoDocs = input.hasProject === true ? await loadRepoDocsStep(conversationId) : [];
  const agent = new WorkflowAgent({
    model,
    instructions: buildInstructions({
      hasSandbox: input.hasSandbox ?? true,
      hosts: input.hosts ?? [],
      repoDocs,
      skill,
    }),
    // 0042: WorkflowAgent hard-codes supportedUrls: {}, so the SDK would try
    // to fetch every URL part itself. Returning null passes `attachment:`
    // references through untouched; the model wrapper resolves them to
    // bytes inside its step (never into recorded workflow state).
    experimental_download: async (requests) => requests.map(() => null),
    tools: buildChatTools(conversationId, {
      hasSandbox: input.hasSandbox ?? true,
      hasProject: input.hasProject ?? true,
      hosts: input.hosts ?? [],
    }),
  });

  // The current send's viewing note: a user-role message right before
  // the send (the agent forbids system messages in `messages`), model
  // input only — it is persisted as metadata on the user row above and
  // rebuilt by listTurnMessages; persistTurn's skip keeps it out.
  let messages: ModelMessage[] = [
    ...history,
    ...(input.viewing ? [{ role: "user" as const, content: viewingNote(input.viewing) }] : []),
    { role: "user", content: userContent },
  ];
  let finishReason: string = "stop";
  let stored = 0;
  let exhausted = false;
  // 0047: one usage_events row per turn. startedAt is the turn's own
  // clock (before the first slice); token counts sum the slices.
  const startedAt = Date.now();
  let slices = 0;
  let turnUsage: UsageCounts = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  // skip = everything already persisted (loaded history + this turn's
  // user message) plus the injected note, which sits right before it.
  const skip = history.length + (input.viewing ? 1 : 0) + 1;
  // One durable stream per TURN, not per slice: every slice leaves it
  // open and unfinished; finishTurnStream ends it exactly once — also
  // when a slice throws, so a reconnected browser is never left hanging.
  // It ends AFTER persistTurn: a browser that sees `finish` may reload
  // the conversation from sqlite (the fresh page's /c adoption does) and
  // must find the whole turn there.
  // A slice that throws is caught so a turn that already talked to a
  // model still records what it spent; the original error is rethrown
  // after the write. A throw before any slice (nothing to meter) skips
  // the row. The usage write itself never fails the turn.
  let turnError: unknown;
  try {
    try {
      for (let step = 0; step < maxSteps; step += 1) {
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
        slices += 1;
        turnUsage = addUsage(turnUsage, readSliceUsage(result));
        messages = stripLeadingSystem(result.messages);
        finishReason = result.finishReason;

        // The turn ends when the latest assistant message asks for no tools.
        // Computed BEFORE persisting this slice (0040 phase 3): when this
        // is the LAST possible step and it still wants tools, the turn is
        // about to end by running out of budget, not by the model's
        // choice — tag that slice's own persist so the row carries it
        // durably (the wake, in-run or swept later, reads it back).
        const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
        const wantsTools =
          lastAssistant != null &&
          Array.isArray(lastAssistant.content) &&
          lastAssistant.content.some((part) => part.type === "tool-call");
        const exhaustedThisSlice = wantsTools && step === maxSteps - 1;
        // Each finished slice lands in sqlite now — a long turn is visible
        // (inspect, monitors, reloads) while it runs, not only at its end.
        stored += await persistTurn(conversationId, messages, skip, resolved, {
          from: skip + stored,
          final: false,
          exhausted: exhaustedThisSlice,
        });

        if (!wantsTools) break;
        if (exhaustedThisSlice) exhausted = true;
      }

      // The rest of the tail (normally nothing) and the active-run clear.
      stored += await persistTurn(conversationId, messages, skip, resolved, { from: skip + stored, final: true });
    } finally {
      await finishTurnStream(writable);
    }
  } catch (err) {
    turnError = err;
  }
  if (slices > 0) {
    try {
      await recordUsageStep(
        conversationId,
        skip,
        resolved.route,
        turnUsage,
        slices,
        countToolCalls(messages, skip),
        startedAt,
      );
    } catch (err) {
      console.error("[usage] chat capture failed", err);
    }
  }
  if (turnError) throw turnError;
  // 0037: a thread-skill turn that ran out of budget mid-work continues
  // in a fresh turn (bounded — see lib/chat/budget.ts).
  if (exhausted && skill) await continueAfterBudgetStep(conversationId);
  // 0037 phase 3: a child thread reports its settle to its parent —
  // after the budget decision, so a continuing child still reads as
  // working. One select for every other conversation.
  await wakeParentStep(conversationId);
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

/** Tool calls this turn asked for — assistant parts from `from` on, so
 *  an earlier turn's calls (still in the history prefix) are not counted
 *  again. */
function countToolCalls(messages: ModelMessage[], from: number): number {
  let n = 0;
  for (let i = from; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-call") n += 1;
    }
  }
  return n;
}
