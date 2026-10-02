import type { ModelMessage } from "ai";

/**
 * 0010 spike turn side effects — every function here is a `"use step"`
 * (replay-safe via recorded results); Node/sqlite imports happen inside,
 * same pattern as workflows/machines/steps.ts. The workflow body
 * (turn.ts) only orchestrates.
 *
 * Relative imports throughout: this tree is compiled into the workflow
 * bundle, where the "@/" alias is not guaranteed outside Next.
 */

/**
 * Load the conversation's model history. Steer rows queued while no turn
 * was running are folded in as user messages first (and persisted), so a
 * message that arrived "between turns" is never lost.
 */
export async function loadTurnHistory(
  conversationId: string,
): Promise<ModelMessage[]> {
  "use step";
  const [{ db }, chat] = await Promise.all([
    import("../../db"),
    import("../../db/chat"),
  ]);
  const queued = chat.drainSteer(db(), conversationId);
  if (queued.length > 0) {
    chat.appendMessages(
      db(),
      conversationId,
      queued.map((text, i) => ({
        id: `sq_${conversationId}_${Date.now()}_${i}`,
        role: "user" as const,
        text,
        modelMessage: { role: "user", content: text },
      })),
    );
  }
  return chat.listModelMessages(db(), conversationId);
}

/**
 * Persist the turn's user message. Id is keyed on the conversation's
 * persisted-history length — stable for a given run (replay-safe), never
 * colliding across turns (history only grows).
 */
export async function recordUserMessage(
  conversationId: string,
  text: string,
  seq: number,
): Promise<void> {
  "use step";
  const [{ db }, chat] = await Promise.all([
    import("../../db"),
    import("../../db/chat"),
  ]);
  chat.appendMessages(db(), conversationId, [
    {
      id: `t_${conversationId}_${seq}`,
      role: "user",
      text,
      modelMessage: { role: "user", content: text },
    },
  ]);
}

/**
 * Drain the steer queue for the running turn (mid-turn injection, called
 * from the turn's prepareStep before each model step after the first).
 * A step — not a helper — because only step bodies may touch sqlite; the
 * recorded result also makes a replayed turn re-inject the same steer
 * messages deterministically. Injected messages are persisted by
 * persistTurn (they appear in the agent's final message list).
 */
export async function drainSteerStep(conversationId: string): Promise<string[]> {
  "use step";
  const [{ db }, chat] = await Promise.all([
    import("../../db"),
    import("../../db/chat"),
  ]);
  return chat.drainSteer(db(), conversationId);
}

/**
 * 0010 Phase 3: run a bash command in the conversation's dedicated
 * sandbox (created on first use). Output is clipped by the tool core
 * (step results serialize into the run log).
 */
export async function bashStep(
  conversationId: string,
  command: string,
  toolCallId?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  "use step";
  const { runBash } = await import("../../lib/agent/tools/bash");
  return runBash(conversationId, command, undefined, toolCallId);
}

/** 0010 Phase 3: open a PR on one of the bound project's repos (0004 D). */
export async function createPrStep(
  conversationId: string,
  input: {
    repo: string;
    head: string;
    base?: string;
    title: string;
    body?: string;
  },
): Promise<unknown> {
  "use step";
  const [{ db }, { getConversation }, { openProjectPR }] = await Promise.all([
    import("../../db"),
    import("../../db/chat"),
    import("../../lib/git-hosts/open-pr"),
  ]);
  const projectId = getConversation(db(), conversationId)?.projectId;
  if (!projectId) throw new Error("no project bound to this conversation");
  return openProjectPR({ projectId, ...input });
}

/** 0010 Phase 3: machines available in this conversation (0009). */
export async function listMachinesStep(
  conversationId: string,
): Promise<unknown> {
  "use step";
  const { listAvailableMachines } = await import("../../lib/agent/tools/start-machine");
  return listAvailableMachines(conversationId);
}

/** 0010 Phase 3: start a machine run directly, in-process (0009). */
export async function startMachineStep(
  conversationId: string,
  input: { machineId: string; prompt: string },
): Promise<{ runId: string; url: string }> {
  "use step";
  const { startMachineRun } = await import("../../lib/agent/tools/start-machine");
  return startMachineRun({ conversationId, ...input });
}

/** 0010 Phase 4: record a pending human-input request (the ask_chad
 *  tool calls this before awaiting its hook — workflow context cannot
 *  touch sqlite, and the inbox needs the row before the answer). */
export async function pendingStep(
  conversationId: string,
  id: string,
  question: string,
  kind: "approval" | "question" = "approval",
): Promise<void> {
  "use step";
  const [{ db }, chat] = await Promise.all([
    import("../../db"),
    import("../../db/chat"),
  ]);
  chat.recordPendingInput(db(), { id, conversationId, kind, question });
}

/** 0010 Phase 4: generated titles (0007) for new-runtime conversations —
 *  fired from the turn (the mirror hook fired for eve's). */
export async function maybeTitleStep(conversationId: string): Promise<void> {
  "use step";
  const { maybeGenerateTitle } = await import("../../lib/titles");
  await maybeGenerateTitle(conversationId);
}

/**
 * Persist the turn's new messages (result.messages tail — includes
 * mid-turn steer injections) and clear the conversation's active run.
 * Exactly one turn runs per conversation at a time (route-enforced), so
 * an unconditional clear-if-set cannot clobber another turn.
 */
export async function persistTurn(
  conversationId: string,
  messages: ModelMessage[],
  skip: number,
): Promise<number> {
  "use step";
  const [{ db }, chat] = await Promise.all([
    import("../../db"),
    import("../../db/chat"),
  ]);
  const tail: {
    id: string;
    role: "user" | "assistant" | "tool";
    text: string;
    modelMessage: ModelMessage;
  }[] = [];
  messages.slice(skip).forEach((message, i) => {
    tail.push({
      id: `m_${conversationId}_${skip + i}_${Math.random().toString(36).slice(2, 8)}`,
      role: message.role === "assistant" ? "assistant" : message.role === "tool" ? "tool" : "user",
      text: textOf(message),
      modelMessage: message,
    });
  });
  chat.appendMessages(db(), conversationId, tail);
  chat.setActiveRun(db(), conversationId, null);
  return tail.length;
}

/** Best-effort plain-text extraction for the searchable `text` column. */
function textOf(message: ModelMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "tool-call") return `[tool ${part.toolName}]`;
      if (part.type === "tool-result")
        return typeof part.output === "string"
          ? part.output
          : JSON.stringify(part.output);
      return "";
    })
    .join("")
    .trim();
}
