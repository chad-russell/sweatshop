import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDb } from "../db";
import { mirrorStreamEvent } from "../db/mirror";

// Invariant 4 (failsafe): mirror write failures are logged and never
// propagate into the eve stream. This file gets its own temp db (one
// setup run per isolated worker); we drop the events table to force the
// insert to fail, then assert the call returns normally.
const tdb = openDb(process.env.SWEATSHOP_DB!);

describe("mirror failsafe", () => {
  it("never throws when the write fails", () => {
    const sqlite = tdb.$client as unknown as Database.Database;
    sqlite.exec("drop table conversation_events");

    expect(() =>
      mirrorStreamEvent("wrun_failsafe", {
        type: "session.started",
        meta: { id: "evt_failsafe", at: "2026-09-29T12:00:00.000Z" },
      }),
    ).not.toThrow();
  });
});
