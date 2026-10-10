// Throwaway live monitor for one playbook thread (run 5). Not committed.
import Database from "better-sqlite3";
const CONV = process.argv[2];
const db = new Database("data/sweatshop.db", { readonly: true });
const q = (sql, ...a) => db.prepare(sql).all(...a);
let last = "";
const deadline = Date.now() + 120 * 60 * 1000;
while (Date.now() < deadline) {
  const [conv] = q("SELECT active_run_id, sandbox_id, playbook FROM conversations WHERE id = ?", CONV);
  const counts = q("SELECT role, count(*) n FROM messages WHERE conversation_id = ? GROUP BY role", CONV);
  const lastMsg = q("SELECT role, substr(text,1,140) AS t FROM messages WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1", CONV)[0];
  const pend = q("SELECT id, kind, substr(question,1,80) q, resolved_at FROM pending_inputs WHERE conversation_id = ?", CONV);
  const calls = q("SELECT id, kind, status FROM harness_calls WHERE conversation_id = ?", CONV);
  const previews = conv?.sandbox_id ? q("SELECT status, slug FROM previews WHERE sandbox_id = ?", conv.sandbox_id) : [];
  const sig = JSON.stringify({ conv, pend, calls, previews, lastMsg: lastMsg?.t });
  if (sig !== last) {
    last = sig;
    console.log(`[${new Date().toISOString().slice(11, 19)}]`, JSON.stringify({ conv, counts, pend, calls, previews, lastMsg }));
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
