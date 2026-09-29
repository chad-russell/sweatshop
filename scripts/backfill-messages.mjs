import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * 0003 backfill: extract message rows from already-mirrored conversation
 * events (message.received / message.completed). Idempotent — keyed on the
 * event ULID, so re-running inserts nothing new. Safe to run any time.
 */
const dbPath = process.env.SWEATSHOP_DB ?? path.join(process.cwd(), "data", "sweatshop.db");
mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");

const ensureConversation = db.prepare(
  `insert into conversations (id, created_at, updated_at) values (?, ?, ?)
   on conflict(id) do nothing`,
);
const hasMessage = db.prepare("select 1 from messages where id = ?");
const insertMessage = db.prepare(
  "insert into messages (id, conversation_id, role, text, at) values (?, ?, ?, ?, ?)",
);

const rows = db
  .prepare(
    `select conversation_id, event from conversation_events
     where type in ('message.received', 'message.completed')
     order by rowid`,
  )
  .all();

let extracted = 0;
let skipped = 0;
let irrelevant = 0;

for (const row of rows) {
  let envelope;
  try {
    envelope = JSON.parse(row.event);
  } catch {
    skipped += 1;
    continue;
  }
  const id = envelope?.meta?.id;
  const data = envelope?.data;
  if (typeof id !== "string") {
    skipped += 1;
    continue;
  }
  const role =
    envelope.type === "message.received"
      ? "user"
      : envelope.type === "message.completed"
        ? "assistant"
        : null;
  if (!role || typeof data?.message !== "string" || !data.message.trim()) {
    irrelevant += 1;
    continue;
  }
  if (data.kind === "execution.background_task") {
    irrelevant += 1;
    continue;
  }
  if (hasMessage.get(id)) {
    skipped += 1;
    continue;
  }
  const at = envelope.meta?.at ? Date.parse(envelope.meta.at) || 0 : 0;
  ensureConversation.run(row.conversation_id, at || Date.now(), at || Date.now());
  insertMessage.run(id, row.conversation_id, role, data.message, at);
  extracted += 1;
}

console.log(
  `backfill: ${extracted} extracted, ${skipped} skipped (present/unparseable), ${irrelevant} irrelevant`,
);
