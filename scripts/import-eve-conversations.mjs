import Database from "better-sqlite3";

/**
 * 0010 Phase 4: best-effort import of existing eve conversations into
 * the new chat runtime's store. The mirror already extracted plain-text
 * rows into `messages`; this gives each conversation without any
 * `model_message` rows a synthesized ModelMessage history from those
 * text rows (user/assistant only — eve-specific parts are dropped, per
 * the approved "only if it falls out trivially" resolution).
 *
 * Idempotent: conversations that already have model_message rows are
 * left alone.
 *
 *   node scripts/import-eve-conversations.mjs            (dry run)
 *   APPLY=1 node scripts/import-eve-conversations.mjs    (import)
 */
const APPLY = process.env.APPLY === "1";

const dbPath =
  process.env.SWEATSHOP_DB ??
  new URL("../data/sweatshop.db", import.meta.url).pathname;
const sqlite = new Database(dbPath);
sqlite.pragma("foreign_keys = ON");

const conversations = sqlite
  .prepare("select id from conversations order by created_at")
  .all()
  .map((row) => row.id);

let imported = 0;
let skipped = 0;
for (const id of conversations) {
  const hasNewRows = sqlite
    .prepare("select 1 from messages where conversation_id = ? and model_message is not null limit 1")
    .get(id);
  if (hasNewRows) {
    skipped += 1;
    continue;
  }
  const rows = sqlite
    .prepare(
      "select id, role, text from messages where conversation_id = ? order by rowid",
    )
    .all(id);
  if (rows.length === 0) {
    skipped += 1;
    continue;
  }
  const usable = rows.filter((r) => r.role === "user" || r.role === "assistant");
  console.log(
    `${APPLY ? "importing" : "would import"} ${id}: ${usable.length}/${rows.length} text rows`,
  );
  if (APPLY) {
    const insert = sqlite.prepare(
      "insert into messages (id, conversation_id, role, text, model_message, at) values (?, ?, ?, ?, ?, ?)",
    );
    const deleteSuperseded = sqlite.prepare(
      "delete from messages where conversation_id = ? and id not like 'imp_%' and model_message is null",
    );
    const at = Date.now();
    const tx = sqlite.transaction(() => {
      for (const row of usable) {
        insert.run(
          `imp_${row.id}`,
          id,
          row.role,
          row.text,
          JSON.stringify({ role: row.role, content: row.text }),
          at,
        );
      }
      // The imported rows supersede the mirror-extracted originals (one
      // lineage — display and search see each message once).
      deleteSuperseded.run(id);
    });
    tx();
  }
  imported += 1;
}

console.log(
  `import-eve-conversations: ${imported} ${imported === 1 ? "conversation" : "conversations"} ${APPLY ? "imported" : "eligible"}, ${skipped} skipped`,
);
sqlite.close();
