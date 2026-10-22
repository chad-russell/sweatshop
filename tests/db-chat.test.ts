import { describe, expect, it } from "vitest";
import { db } from "../db";
import { appendMessages, ensureConversation, lastAssistantReport, listMessageTexts, listMessageTextsPage } from "../db/chat";
import { messages as messagesTable } from "../db/schema";

/**
 * 0040 phase 3: `lastAssistantReport` — the wake's source of "what did
 * the child actually say," distinct from whether the turn that produced
 * it hit its step budget (`exhausted`, carried on the newest row only).
 */

let seq = 0;
const chatId = () => `c_dbchat_${++seq}`;

describe("lastAssistantReport", () => {
  it("returns null for a conversation with no assistant rows", () => {
    const id = chatId();
    ensureConversation(db(), id);
    expect(lastAssistantReport(db(), id)).toBeNull();
  });

  it("skips placeholder-only rows and returns the newest real text", () => {
    const id = chatId();
    ensureConversation(db(), id);
    appendMessages(db(), id, [
      { id: `${id}_1`, role: "assistant", text: "Findings: the dialog clips.", modelMessage: { role: "assistant", content: "x" } },
      { id: `${id}_2`, role: "assistant", text: "[tool bash]", modelMessage: { role: "assistant", content: "x" } },
    ]);
    expect(lastAssistantReport(db(), id)).toEqual({ text: "Findings: the dialog clips.", exhausted: false });
  });

  it("a row that is only whitespace around placeholders still counts as empty", () => {
    const id = chatId();
    ensureConversation(db(), id);
    appendMessages(db(), id, [
      { id: `${id}_1`, role: "assistant", text: "  [tool bash]  [tool pi]  ", modelMessage: { role: "assistant", content: "x" } },
    ]);
    expect(lastAssistantReport(db(), id)).toBeNull();
  });

  it("reports exhausted from the newest row even when that row itself has no text", () => {
    const id = chatId();
    ensureConversation(db(), id);
    appendMessages(db(), id, [
      { id: `${id}_1`, role: "assistant", text: "partial findings so far", modelMessage: { role: "assistant", content: "x" } },
      { id: `${id}_2`, role: "assistant", text: "[tool bash]", modelMessage: { role: "assistant", content: "x" }, metadata: { exhausted: true } },
    ]);
    expect(lastAssistantReport(db(), id)).toEqual({ text: "partial findings so far", exhausted: true });
  });

  it("is not exhausted when the newest row finished cleanly", () => {
    const id = chatId();
    ensureConversation(db(), id);
    appendMessages(db(), id, [
      { id: `${id}_1`, role: "assistant", text: "all done", modelMessage: { role: "assistant", content: "x" } },
    ]);
    expect(lastAssistantReport(db(), id)).toEqual({ text: "all done", exhausted: false });
  });
});

/**
 * Tail-first paging (listMessageTextsPage): `tail` newest rows
 * oldest-first, `before` rowid paging, olderRemaining counts, and the
 * lineage filter (text-only rows superseded once modelMessage rows
 * exist) applying inside pages and counts alike.
 */
describe("listMessageTextsPage", () => {
  /** Insert rows one at a time (rowid = insertion order) with full control
   *  over modelMessage (null = a pre-0010 text-only mirror row). Ids are
   *  globally unique (messages.id is the PK) via a file-wide counter. */
  let rid = 0;
  function seed(id: string, rows: { role: string; text: string; modelMessage?: object | null }[]) {
    ensureConversation(db(), id);
    let at = 1000;
    const ids: string[] = [];
    for (const row of rows) {
      const rowId = `r${++rid}`;
      ids.push(rowId);
      db()
        .insert(messagesTable)
        .values({
          id: rowId,
          conversationId: id,
          role: row.role,
          text: row.text,
          modelMessage:
            row.modelMessage === undefined
              ? JSON.stringify({ role: row.role, content: row.text })
              : row.modelMessage == null
                ? null
                : JSON.stringify(row.modelMessage),
          at: ++at,
        })
        .run();
    }
    return ids;
  }

  it("no opts returns every row oldest-first — listMessageTexts unchanged", () => {
    const id = chatId();
    const ids = seed(id, [
      { role: "user", text: "one" },
      { role: "assistant", text: "two" },
      { role: "user", text: "three" },
    ]);
    const page = listMessageTextsPage(db(), id);
    expect(page.rows.map((r) => r.id)).toEqual(ids);
    expect(page.olderCursor).toBeNull();
    expect(page.olderRemaining).toBe(0);
    expect(listMessageTexts(db(), id).map((r) => r.id)).toEqual(ids);
  });

  it("tail N returns the newest N rows oldest-first with a cursor and the right count", () => {
    const id = chatId();
    const ids = seed(id, Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `t${i}` })));
    const page = listMessageTextsPage(db(), id, { tail: 4 });
    expect(page.rows.map((r) => r.id)).toEqual(ids.slice(6));
    expect(page.olderRemaining).toBe(6);
    expect(page.olderCursor).toBeTypeOf("number");
    // The cursor is the rowid of the page's first row: paging before it
    // yields exactly the older rows, newest page first.
    const older = listMessageTextsPage(db(), id, { tail: 4, before: page.olderCursor! });
    expect(older.rows.map((r) => r.id)).toEqual(ids.slice(2, 6));
    expect(older.olderRemaining).toBe(2);
  });

  it("pages chain backwards to the start of the conversation (cursor null at the end)", () => {
    const id = chatId();
    const ids = seed(id, Array.from({ length: 7 }, (_, i) => ({ role: "user", text: `t${i}` })));
    const seen: string[] = [];
    let before: number | undefined;
    for (;;) {
      const page = listMessageTextsPage(db(), id, { tail: 3, ...(before != null ? { before } : {}) });
      seen.push(...page.rows.map((r) => r.id));
      if (page.olderCursor == null) {
        expect(page.olderRemaining).toBe(0);
        break;
      }
      before = page.olderCursor;
    }
    // Pages accumulate newest-page-first, each page oldest-first inside
    // itself — and together they cover every row exactly once.
    const expected: string[] = [];
    for (let end = ids.length; end > 0; end -= 3) expected.push(...ids.slice(Math.max(0, end - 3), end));
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(ids.length); // no row twice
  });

  it("the lineage filter applies inside pages and counts: superseded text-only rows never surface", () => {
    const id = chatId();
    seed(id, [
      { role: "user", text: "old mirror", modelMessage: null },
      { role: "assistant", text: "old reply", modelMessage: null },
      ...Array.from({ length: 4 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `t${i}` })),
    ]);
    // Full list drops the mirror rows (today's behavior); ids[0..1] are the
    // new-runtime rows, ids[2..3] the newer pair.
    const all = listMessageTexts(db(), id);
    const ids = all.map((r) => r.id);
    expect(all).toHaveLength(4);
    // A tail covering everything counts only the surviving lineage.
    const page = listMessageTextsPage(db(), id, { tail: 10 });
    expect(page.rows.map((r) => r.id)).toEqual(ids);
    expect(page.olderCursor).toBeNull();
    expect(page.olderRemaining).toBe(0);
    // A page whose older side holds ONLY mirror rows is already at the start.
    const head = listMessageTextsPage(db(), id, { tail: 2 });
    expect(head.rows.map((r) => r.id)).toEqual(ids.slice(2));
    expect(head.olderRemaining).toBe(2);
    const prev = listMessageTextsPage(db(), id, { tail: 2, before: head.olderCursor! });
    expect(prev.rows.map((r) => r.id)).toEqual(ids.slice(0, 2));
    expect(prev.olderCursor).toBeNull(); // the two mirror rows don't count
    expect(prev.olderRemaining).toBe(0);
  });

  it("a text-only conversation (no modelMessage rows) keeps its rows", () => {
    const id = chatId();
    const ids = seed(id, [
      { role: "user", text: "only text", modelMessage: null },
      { role: "assistant", text: "still text", modelMessage: null },
    ]);
    const page = listMessageTextsPage(db(), id, { tail: 1 });
    expect(page.rows.map((r) => r.id)).toEqual([ids[1]!]);
    expect(page.olderRemaining).toBe(1);
    expect(page.olderCursor).toBeTypeOf("number");
  });

  it("an unknown conversation is an empty, exhausted page", () => {
    const page = listMessageTextsPage(db(), chatId(), { tail: 50 });
    expect(page).toEqual({ rows: [], olderCursor: null, olderRemaining: 0 });
  });
});
