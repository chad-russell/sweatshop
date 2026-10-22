/**
 * Seed a long demo conversation for preview work (0075): one chat with
 * ~405 message rows (40 turns × 1 user + 9 assistant rows; turn 35
 * runs 5 slices long) so the tail-window hydration and the "Load earlier
 * messages" sentinel are visible without touching real data.
 *
 * Rows carry real `model_message` payloads (the runtime shape — turns
 * fold into one user + one assistant bubble), and the row count is
 * chosen so the newest-150 hydration boundary lands MID-turn (row 256
 * = turn 26 slice 5): the window-alignment fixup's before/after is
 * visible directly on this data.
 *
 *   SWEATSHOP_DB=/tmp/demo.db node scripts/demo-long-chat.mjs
 *
 * Idempotent: a conversation with this id already present is left as
 * is. Migrations are NOT run here — run scripts/migrate.mjs first.
 */
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

const CONVERSATION_ID = "demo-long-chat";
const TURNS = 40;
const ASSISTANT_ROWS = 9;
// Turn 35 runs 5 slices long (405 rows total): the newest-150 window
// would otherwise be exactly 15 turns, opening on a turn opener — with
// it, the window opens at row 256, turn 26 slice 5, mid-fold.
const LONG_TURN = 35;
const LONG_EXTRA = 5;

const dbPath = process.env.SWEATSHOP_DB;
if (!dbPath) {
  console.error("set SWEATSHOP_DB to the (migrated) db to seed");
  process.exit(2);
}

const sqlite = new Database(dbPath);
sqlite.pragma("foreign_keys = ON");

const existing = sqlite
  .prepare("select id from conversations where id = ?")
  .get(CONVERSATION_ID);
if (existing) {
  console.log(`already seeded: ${dbPath} (${CONVERSATION_ID})`);
  process.exit(0);
}

const now = Date.now();
sqlite
  .prepare(
    "insert into conversations (id, title, title_source, created_at, updated_at) values (?, ?, 'manual', ?, ?)",
  )
  .run(CONVERSATION_ID, "Demo long chat", now, now);

const insert = sqlite.prepare(
  "insert into messages (id, conversation_id, role, text, model_message, at) values (?, ?, ?, ?, ?, ?)",
);
const seed = sqlite.transaction(() => {
  for (let turn = 1; turn <= TURNS; turn += 1) {
    const opener = `Turn ${turn}: please continue the demo transcript.`;
    insert.run(
      `t_${CONVERSATION_ID}_${turn}`,
      CONVERSATION_ID,
      "user",
      opener,
      JSON.stringify({ role: "user", content: opener }),
      now + turn,
    );
    const slices = ASSISTANT_ROWS + (turn === LONG_TURN ? LONG_EXTRA : 0);
    for (let i = 1; i <= slices; i += 1) {
      const text = `Turn ${turn}, slice ${i}: ${randomUUID()} — the quick brown fox jumps over the lazy dog while the transcript scrolls by.`;
      insert.run(
        `m_${CONVERSATION_ID}_${turn}_${i}`,
        CONVERSATION_ID,
        "assistant",
        text,
        JSON.stringify({ role: "assistant", content: text }),
        now + turn * 100 + i,
      );
    }
  }
  sqlite
    .prepare("update conversations set updated_at = ? where id = ?")
    .run(now + TURNS * 100 + ASSISTANT_ROWS + LONG_EXTRA, CONVERSATION_ID);
});
seed();

const rows = sqlite
  .prepare("select count(*) as n from messages where conversation_id = ?")
  .get(CONVERSATION_ID);
console.log(`seeded: ${dbPath} (${CONVERSATION_ID}, ${rows.n} message rows)`);
