import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { ownerName } from "@/lib/agent/owner";
import type { MessageRowMetadata } from "@/db/chat";
import { messages } from "@/db/schema";

/**
 * 0037/0039: a thread-skill turn that exhausts its step budget is still working —
 * it continues in a fresh turn through the wake path (a chip, never
 * Chad's words). Bounded: after MAX_CONTINUATIONS in a row with no human
 * message between them, the thread stops and waits (its last output is
 * unread; Chad's next message resumes it).
 */
export const MAX_CONTINUATIONS = 3;

/** Budget continuations since the last message Chad typed. */
export function continuationsSinceHuman(conversationId: string): number {
  const rows = db()
    .select({ role: messages.role, metadata: messages.metadata })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(sql`rowid`))
    .all();
  let count = 0;
  for (const row of rows) {
    if (row.role !== "user") continue;
    const meta = row.metadata ? (JSON.parse(row.metadata) as MessageRowMetadata) : null;
    if (!meta?.runEvent) break; // Chad's own message
    if (meta.runEvent.kind === "budget") count += 1;
  }
  return count;
}

export const CONTINUE_TEXT =
  "[budget] Your turn hit its step budget mid-work. Continue from where you are — " +
  `or, if you are stuck, stop and ask ${ownerName()} (ask_owner) what they want.`;

/** Start the continuation turn, or report that the bound was reached. */
export async function continueAfterBudget(
  conversationId: string,
  deps: { start?: (id: string, text: string) => Promise<unknown> } = {},
): Promise<"continued" | "bounded"> {
  if (continuationsSinceHuman(conversationId) >= MAX_CONTINUATIONS) return "bounded";
  const start =
    deps.start ??
    (async (id: string, text: string) => {
      const { startChatTurn } = await import("@/lib/chat/start-turn");
      await startChatTurn(id, text, undefined, { kind: "budget", id, status: "continuing" });
    });
  await start(conversationId, CONTINUE_TEXT);
  return "continued";
}
