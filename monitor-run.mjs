// Throwaway live monitor for one machine run — polls the DB read-only
// and prints a line whenever the observable state changes. Not committed.
import Database from "better-sqlite3";

const CONV = process.argv[2];
const db = new Database("data/sweatshop.db", { readonly: true });
const q = (sql, ...a) => db.prepare(sql).all(...a);

let last = "";
const deadline = Date.now() + 180 * 60 * 1000;
while (Date.now() < deadline) {
  const [conv] = q("SELECT id, title, sandbox_id, active_run_id FROM conversations WHERE id = ?", CONV);
  const runs = q("SELECT id, status, current_stage, settled_at, error FROM machine_runs WHERE parent_conversation_id = ?", CONV);
  const run = runs[0];
  const stages = run
    ? q("SELECT seq, stage_id, kind, harness, status, steps, substr(coalesce(outcome,''),1,120) AS o FROM machine_stage_runs WHERE run_id = ? ORDER BY seq", run.id)
    : [];
  const lastMsg = q("SELECT role, substr(text,1,150) AS t, at FROM messages WHERE conversation_id = ? ORDER BY at DESC LIMIT 1", CONV)[0];
  const previews = conv?.sandbox_id
    ? q("SELECT id, status, slug FROM previews WHERE sandbox_id = ?", conv.sandbox_id)
    : [];
  const proposals = run ? q("SELECT status, head FROM pr_proposals WHERE run_id = ?", run.id) : [];
  const sig = JSON.stringify({ conv, run, stages, previews, proposals, lastMsg });
  if (sig !== last) {
    last = sig;
    console.log(`\n[${new Date().toISOString().slice(11, 19)}]`, JSON.stringify({ conv, run, stages, previews, proposals, lastMsg }, null, 0));
  }
  if (run && ["completed", "failed", "cancelled"].includes(run.status)) {
    console.log("\n[monitor] chat idle + run settled — done");
    break;
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
console.log("[monitor] exit");
