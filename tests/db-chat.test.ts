import { describe, expect, it } from "vitest";
import { db } from "../db";
import { appendMessages, ensureConversation, lastAssistantReport } from "../db/chat";

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
