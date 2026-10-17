import { describe, expect, it } from "vitest";
import { db } from "../db";
import { ensureConversation } from "../db/chat";
import { createHarnessCall, getHarnessCall } from "../db/harness-calls";
import { RESULT_FILE_CAP } from "../lib/chat/result-file";
import { harnessSettleStep } from "../workflows/chat/harness-step";

/**
 * 0040 phase 3: `harness_calls.result` now holds the harness's final
 * message up to 60k chars (RESULT_FILE_CAP), not the old 2k clip — the
 * wake's own, tighter clip (WAKE_DETAIL_CAP) is separate and applied at
 * read time, not storage time. The wake this step fires is not under
 * test here (no workflow runtime in this process) — only what lands in
 * the row, which the step writes before ever touching the wake.
 */

let seq = 0;
const chatId = () => `c_hcsettle_${++seq}`;

describe("harnessSettleStep: stored result size", () => {
  it("stores up to 60k chars, clipped beyond that", async () => {
    const conversationId = chatId();
    ensureConversation(db(), conversationId, null);
    const call = createHarnessCall(db(), { conversationId, kind: "pi", task: "x" });
    const longText = "y".repeat(RESULT_FILE_CAP + 10_000);

    await harnessSettleStep({
      callId: call.id,
      conversationId,
      kind: "pi",
      status: "completed",
      text: longText,
      finalText: longText,
      toolCalls: 1,
    }).catch(() => {}); // the wake it fires has no workflow runtime here

    const row = getHarnessCall(db(), call.id)!;
    expect(row.status).toBe("completed");
    expect(row.result!.length).toBeLessThanOrEqual(RESULT_FILE_CAP + 1); // +1 for clipHarnessText's "…"
    expect(row.result!.length).toBeGreaterThan(2_000); // well past the old cap
  });

  it("stores short results verbatim", async () => {
    const conversationId = chatId();
    ensureConversation(db(), conversationId, null);
    const call = createHarnessCall(db(), { conversationId, kind: "pi", task: "x" });

    await harnessSettleStep({
      callId: call.id,
      conversationId,
      kind: "pi",
      status: "completed",
      text: "short",
      finalText: "short",
      toolCalls: 0,
    }).catch(() => {});

    expect(getHarnessCall(db(), call.id)!.result).toBe("short");
  });
});
