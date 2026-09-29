import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { mirrorStreamEvent } from "../db/mirror";
import { searchConversations, toFtsPhrase } from "../db/search";

const tdb = openDb(process.env.SWEATSHOP_DB!);

let seq = 0;
function envelope(
  type: string,
  data?: unknown,
): Parameters<typeof mirrorStreamEvent>[1] {
  seq += 1;
  return {
    type,
    data,
    meta: {
      id: `evt_search${String(seq).padStart(18, "0")}`,
      at: "2026-09-29T12:00:00.000Z",
    },
  };
}

function seedConversation(id: string, userText: string, assistantText: string) {
  mirrorStreamEvent(id, envelope("session.started"));
  mirrorStreamEvent(id, envelope("message.received", { message: userText }));
  mirrorStreamEvent(
    id,
    envelope("step.completed", { finishReason: "stop" }),
  );
  mirrorStreamEvent(
    id,
    envelope("message.completed", { message: assistantText }),
  );
}

describe("mirror message extraction", () => {
  it("extracts user and assistant text into messages rows", () => {
    seedConversation(
      "wrun_search_a",
      "how do walruses sleep",
      "Walruses sleep in the water and on ice floes.",
    );

    const rows = tdb.$client
      .prepare(
        "select role, text from messages where conversation_id = ? order by rowid",
      )
      .all("wrun_search_a");
    expect(rows).toEqual([
      { role: "user", text: "how do walruses sleep" },
      { role: "assistant", text: "Walruses sleep in the water and on ice floes." },
    ]);
  });

  it("does not re-extract a replayed event (same ULID)", () => {
    seedConversation(
      "wrun_search_b",
      "duplicate question",
      "duplicate answer",
    );
    const count = () =>
      tdb.$client
        .prepare(
          "select count(*) n from messages where conversation_id = ? and role = 'user'",
        )
        .get("wrun_search_b") as { n: number };

    const replay = {
      type: "message.received",
      data: { message: "duplicate question" },
      meta: { id: "evt_search_dup", at: "2026-09-29T12:00:00.000Z" },
    } as const;

    // A distinct event id extracts once (ids identify events, not intent)…
    mirrorStreamEvent("wrun_search_b", replay);
    const afterFirst = count().n;
    // …and replaying the same event id inserts nothing further.
    mirrorStreamEvent("wrun_search_b", replay);
    expect(count().n).toBe(afterFirst);
    expect(afterFirst).toBe(2);
  });
});

describe("searchConversations", () => {
  it("finds conversations by message text with a snippet", () => {
    const hits = searchConversations(tdb, "walruses sleep");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const hit = hits.find((h) => h.conversationId === "wrun_search_a");
    expect(hit).toBeDefined();
    expect(hit!.snippet).toContain("[walruses sleep]");
  });

  it("groups multiple hits into one row per conversation", () => {
    seedConversation(
      "wrun_search_c",
      "tell me about xylophones again",
      "Xylophones: again, they are percussion instruments.",
    );
    const hits = searchConversations(tdb, "xylophones");
    const hit = hits.find((h) => h.conversationId === "wrun_search_c");
    expect(hit).toBeDefined();
    expect(hit!.hits).toBe(2); // user + assistant both matched
  });

  it("returns nothing for empty or unmatched queries", () => {
    expect(searchConversations(tdb, "   ")).toEqual([]);
    expect(searchConversations(tdb, "zzz-no-such-token")).toEqual([]);
  });
});

describe("toFtsPhrase", () => {
  it("phrase-quotes input and doubles inner quotes", () => {
    expect(toFtsPhrase('say "hi" NEAR*')).toBe('"say ""hi"" NEAR*"');
  });

  it("cannot be turned into FTS5 syntax by crafted input", () => {
    // The phrase-quoted form is always a single literal phrase.
    const crafted = toFtsPhrase('a" OR 1=1 --');
    expect(crafted.startsWith('"')).toBe(true);
    expect(crafted.endsWith('"')).toBe(true);
    // Executing the crafted query does not throw and matches nothing.
    expect(() => searchConversations(tdb, 'a" OR 1=1 --')).not.toThrow();
  });
});
