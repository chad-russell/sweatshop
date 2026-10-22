import { describe, expect, it } from "vitest";
import { db } from "../db";
import {
  clearActiveRunIfMatches,
  ensureConversation,
  getActiveRun,
  getActiveStreamCursor,
  setActiveRun,
  setActiveStreamCursor,
} from "../db/chat";

/**
 * 0077 store layer: `conversations.active_stream_cursor` is a property
 * of ONE live run, so it is written/cleared alongside `active_run_id`
 * everywhere that column is touched (`setActiveRun`,
 * `clearActiveRunIfMatches`) — never left dangling for the next run to
 * misread as its own cursor. The end-to-end write (`persistTurn`'s own
 * `getRun(...).getReadable().getTailIndex()` call) is covered live by
 * the workflow-executor tests in x-chat.test.ts-adjacent
 * stream-cursor-turn.test.ts.
 */
describe("active_stream_cursor (0077)", () => {
  it("starts null, and setActiveRun(runId) leaves it null until a slice records one", () => {
    const id = "c_cursor_start";
    ensureConversation(db(), id);
    expect(getActiveStreamCursor(db(), id)).toBeNull();

    setActiveRun(db(), id, "run_1");
    expect(getActiveRun(db(), id)).toBe("run_1");
    expect(getActiveStreamCursor(db(), id)).toBeNull();

    setActiveStreamCursor(db(), id, 7);
    expect(getActiveStreamCursor(db(), id)).toBe(7);
  });

  it("setActiveRun(null) clears both the run and its cursor", () => {
    const id = "c_cursor_clear_set";
    ensureConversation(db(), id);
    setActiveRun(db(), id, "run_1");
    setActiveStreamCursor(db(), id, 12);

    setActiveRun(db(), id, null);
    expect(getActiveRun(db(), id)).toBeNull();
    expect(getActiveStreamCursor(db(), id)).toBeNull();
  });

  it("starting a NEW run resets any cursor the previous one left behind", () => {
    const id = "c_cursor_restart";
    ensureConversation(db(), id);
    setActiveRun(db(), id, "run_1");
    setActiveStreamCursor(db(), id, 99);

    setActiveRun(db(), id, "run_2");
    expect(getActiveRun(db(), id)).toBe("run_2");
    expect(getActiveStreamCursor(db(), id)).toBeNull();
  });

  it("clearActiveRunIfMatches clears the cursor too, only when the run still matches", () => {
    const id = "c_cursor_clear_match";
    ensureConversation(db(), id);
    setActiveRun(db(), id, "run_1");
    setActiveStreamCursor(db(), id, 5);

    // A stale/mismatched runId changes nothing.
    clearActiveRunIfMatches(db(), id, "run_other");
    expect(getActiveRun(db(), id)).toBe("run_1");
    expect(getActiveStreamCursor(db(), id)).toBe(5);

    clearActiveRunIfMatches(db(), id, "run_1");
    expect(getActiveRun(db(), id)).toBeNull();
    expect(getActiveStreamCursor(db(), id)).toBeNull();
  });
});
