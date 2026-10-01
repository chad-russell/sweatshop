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
