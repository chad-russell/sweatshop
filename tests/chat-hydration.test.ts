import { describe, expect, it } from "vitest";
import type { ModelMessage, UIMessage } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { ensureConversation } from "../db/chat";
import { conversations, messages as messagesTable } from "../db/schema";
import ConversationPage from "../app/c/[sessionId]/page";
import { rowsToUIMessages, type StoredRow } from "../lib/chat-ui";

/**
 * 0075 fixup: the hydrated tail window must ALIGN — its oldest row a
 * turn opener (`t_…`) or the conversation's start. A window that opens
 * mid-fold renders a partial first turn (dropping tool results whose
 * calls sit below the seam), and the aligned Load-earlier page then
 * re-splits the turn into two bubbles. These exercise the server page
 * path directly (the panel path shares the alignment rule through
 * extendChatPageBack and dropUnalignedHead — see chat-ui.test.ts).
 */

/** HYDRATE_TAIL in the page — mirrored here so the seam lands mid-turn. */
const TAIL = 150;

/** Seed rows with exact ids/modelMessages; returns the StoredRow view. */
function seedRows(conversationId: string, rows: { id: string; modelMessage: ModelMessage }[]): StoredRow[] {
  ensureConversation(db(), conversationId);
  let at = 1000;
  const stored: StoredRow[] = [];
  for (const row of rows) {
    at += 1;
    db()
      .insert(messagesTable)
      .values({
        id: row.id,
        conversationId,
        role: row.modelMessage.role,
        text: "",
        modelMessage: JSON.stringify(row.modelMessage),
        at,
      })
      .run();
    stored.push({ id: row.id, role: row.modelMessage.role, text: "", at, modelMessage: row.modelMessage });
  }
  return stored;
}

/** n turns of one opener (`t_`) + `slices` assistant rows each. */
function turns(conversationId: string, n: number, slices: number): { id: string; modelMessage: ModelMessage }[] {
  const rows: { id: string; modelMessage: ModelMessage }[] = [];
  for (let turn = 1; turn <= n; turn += 1) {
    rows.push({ id: `t_${conversationId}_${turn}`, modelMessage: { role: "user", content: `turn ${turn}` } });
    for (let i = 1; i <= slices; i += 1) {
      rows.push({
        id: `m_${conversationId}_${turn}_${i}`,
        modelMessage: { role: "assistant", content: `t${turn} s${i}` },
      });
    }
  }
  return rows;
}

/** Hydrate through the page component; surface the props it hands the chat. */
async function hydrate(sessionId: string) {
  const el = (await ConversationPage({ params: Promise.resolve({ sessionId }) })) as unknown as {
    props: {
      initialMessages: UIMessage[];
      activeRunId?: string | null;
      olderCursor?: number | null;
      olderRemaining?: number;
    };
  };
  return el.props;
}

describe("conversation hydration aligns the tail window (0075 fixup)", () => {
  it("extends the window back to the turn opener and folds the seam-straddling tool pair", async () => {
    // 22 turns × 7 rows = 154: the newest 150 open at row 5 — turn 1
    // slice 4, mid-fold.
    const conv = "c_hydr1";
    const rows = turns(conv, 22, 6);
    // Turn 1's slice 2 becomes a tool call and slice 5 its result — the
    // pair straddles the seam (call below row 5, result above), so an
    // unaligned window would drop the result part entirely.
    rows[2] = {
      id: `m_${conv}_1_2`,
      modelMessage: {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "tc1", toolName: "bash", input: { command: "ls" } }],
      },
    };
    rows[5] = {
      id: `m_${conv}_1_5`,
      modelMessage: {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "tc1", toolName: "bash", output: { type: "json", value: { ok: 1 } } }],
      },
    };
    const stored = seedRows(conv, rows);
    expect(stored.length).toBe(154);
    // The unextended window would open mid-fold (turn 1 slice 4)…
    expect(stored[stored.length - TAIL]?.id).toBe(`m_${conv}_1_4`);

    const props = await hydrate(conv);
    // The window starts at the conversation's first turn opener…
    expect(props.initialMessages[0]?.id).toBe(`t_${conv}_1`);
    // …and hydrates exactly what a full hydration produces — same fold
    // ids, so a Load-earlier page (also aligned) can never re-split it.
    expect(props.initialMessages).toEqual(rowsToUIMessages(stored));
    // The seam-straddling tool pair folds settled, not dropped.
    const parts = props.initialMessages[1]?.parts as { type: string; state?: string }[];
    expect(parts.find((p) => p.type === "tool-bash")?.state).toBe("output-available");
    // The extension covered everything older.
    expect(props.olderCursor).toBeNull();
    expect(props.olderRemaining).toBe(0);
  });

  it("aligns even when the live turn's opener is already inside the window", async () => {
    // 21 turns × 7 rows + a live turn (opener + 4 slices) = 152 rows:
    // the window opens at row 3 — mid-fold of turn 1 — while the live
    // turn's `t_` (row 148) is well inside. The old "contains a t_"
    // check stopped here and shipped the split seam.
    const conv = "c_hydr2";
    const rows = [
      ...turns(conv, 21, 6),
      { id: `t_${conv}_22`, modelMessage: { role: "user" as const, content: "live turn" } },
      ...[1, 2, 3, 4].map((i) => ({
        id: `m_${conv}_22_${i}`,
        modelMessage: { role: "assistant" as const, content: `live slice ${i}` },
      })),
    ];
    const stored = seedRows(conv, rows);
    expect(stored.length).toBe(152);
    db().update(conversations).set({ activeRunId: "wr_hydr2" }).where(eq(conversations.id, conv)).run();

    const props = await hydrate(conv);
    expect(props.activeRunId).toBe("wr_hydr2");
    // Aligned to the first opener, and cut at the LIVE turn's opener
    // (0037): everything before it renders from rows, the turn itself
    // replays from the stream.
    expect(props.initialMessages[0]?.id).toBe(`t_${conv}_1`);
    expect(props.initialMessages).toEqual(rowsToUIMessages(stored.slice(0, 148)));
    expect(props.initialMessages.at(-1)?.id).toBe(`t_${conv}_22`);
    expect(props.initialMessages.at(-1)?.role).toBe("user");
  });

  it("walks back to the live turn's opener when it sits below the window", async () => {
    // A short settled turn + one very long live turn: the newest 150
    // rows contain no `t_` at all — the walk must reach the live
    // turn's opener (row 4) so the cut keeps its 160 persisted slices
    // out of the initial render.
    const conv = "c_hydr3";
    const rows = [
      { id: `t_${conv}_1`, modelMessage: { role: "user" as const, content: "settled" } },
      { id: `m_${conv}_1_1`, modelMessage: { role: "assistant" as const, content: "done" } },
      { id: `m_${conv}_1_2`, modelMessage: { role: "assistant" as const, content: "really done" } },
      { id: `t_${conv}_2`, modelMessage: { role: "user" as const, content: "live turn" } },
      ...Array.from({ length: 160 }, (_, i) => ({
        id: `m_${conv}_2_${i + 1}`,
        modelMessage: { role: "assistant" as const, content: `live slice ${i + 1}` },
      })),
    ];
    const stored = seedRows(conv, rows);
    expect(stored.length).toBe(164);
    db()
      .update(conversations)
      .set({ activeRunId: "wr_hydr3" })
      .where(eq(conversations.id, conv))
      .run();

    const props = await hydrate(conv);
    expect(props.activeRunId).toBe("wr_hydr3");
    // The settled turn renders in full; the live turn renders only its
    // opener — the stream replay supplies the 160 slices.
    expect(props.initialMessages).toEqual(rowsToUIMessages(stored.slice(0, 4)));
    expect(props.initialMessages.map((m) => m.id)).toEqual([`t_${conv}_1`, `m_${conv}_1_1`, `t_${conv}_2`]);
  });
});
