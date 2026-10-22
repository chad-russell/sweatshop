/**
 * Seed a long demo conversation for preview work (0075): one chat with
 * ~400 message rows (40 turns × 1 user + 9 assistant text rows) so the
 * tail-window hydration and the "Load earlier messages" sentinel are
 * visible without touching real data.
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
  "insert into messages (id, conversation_id, role, text, at) values (?, ?, ?, ?, ?)",
);
const seed = sqlite.transaction(() => {
  for (let turn = 1; turn <= TURNS; turn++) {
    insert.run(
      `t_${CONVERSATION_ID}_${turn}`,
      CONVERSATION_ID,
      "user",
      `Turn ${turn}: please continue the demo transcript.`,
      now + turn,
    );
    for (let i = 1; i <= ASSISTANT_ROWS; i++) {
      insert.run(
        `m_${CONVERSATION_ID}_${turn}_${i}`,
        CONVERSATION_ID,
        "assistant",
        `Turn ${turn}, slice ${i}: ${randomUUID()} — the quick brown fox jumps over the lazy dog while the transcript scrolls by.`,
        now + turn * 100 + i,
      );
    }
  }
  sqlite
    .prepare("update conversations set updated_at = ? where id = ?")
    .run(now + TURNS * 100 + ASSISTANT_ROWS, CONVERSATION_ID);
});
seed();

const rows = sqlite
  .prepare("select count(*) as n from messages where conversation_id = ?")
  .get(CONVERSATION_ID);
console.log(`seeded: ${dbPath} (${CONVERSATION_ID}, ${rows.n} message rows)`);
