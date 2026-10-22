/**
 * Seed a long demo harness session for preview work (0075): one pi
 * session with ~1500 harness events (30 turns × 1 start + 24 tool
 * pairs + 1 step-end) plus the harness_runs row the /h page validates
 * against, so tail-first hydration and the "Load earlier events"
 * control are visible without touching real data.
 *
 *   SWEATSHOP_DB=/tmp/demo.db node scripts/demo-harness-events.mjs
 *
 * Idempotent: a session that already has events is left as is.
 * Migrations are NOT run here — run scripts/migrate.mjs first.
 */
import Database from "better-sqlite3";

const SESSION_ID = "demo-harness-events";
const TURNS = 30;
const TOOL_PAIRS = 24;

const dbPath = process.env.SWEATSHOP_DB;
if (!dbPath) {
  console.error("set SWEATSHOP_DB to the (migrated) db to seed");
  process.exit(2);
}

const sqlite = new Database(dbPath);
sqlite.pragma("foreign_keys = ON");

const existing = sqlite
  .prepare("select id from harness_events where session_id = ? limit 1")
  .get(SESSION_ID);
if (existing) {
  console.log(`already seeded: ${dbPath} (${SESSION_ID})`);
  process.exit(0);
}

const now = Date.now();
const seed = sqlite.transaction(() => {
  // The parent conversation anchors the breadcrumb; the run row is what
  // /h/pi/<sessionId> validates against.
  sqlite
    .prepare(
      "insert or ignore into conversations (id, title, title_source, created_at, updated_at) values (?, ?, 'manual', ?, ?)",
    )
    .run(SESSION_ID, "Demo long harness session", now, now);
  sqlite
    .prepare(
      `insert into harness_runs (session_id, kind, status, tool_calls, started_at, last_at)
       values (?, 'pi', 'completed', ?, ?, ?)
       on conflict(session_id, kind) do update set status = 'completed', tool_calls = excluded.tool_calls`,
    )
    .run(SESSION_ID, TURNS * TOOL_PAIRS, now, now);

  const insert = sqlite.prepare(
    `insert into harness_events (session_id, harness, at, kind, tool_name, tool_call_id, input, output, text)
     values (?, 'pi', ?, ?, ?, ?, ?, ?, ?)`,
  );
  let at = now;
  let call = 0;
  for (let turn = 1; turn <= TURNS; turn += 1) {
    insert.run(SESSION_ID, ++at, "start", null, null, `Demo task for turn ${turn}: keep the transcript long.`, null, null);
    for (let i = 0; i < TOOL_PAIRS; i += 1) {
      call += 1;
      const tool = i % 3 === 0 ? "bash" : i % 3 === 1 ? "read" : "write";
      const detail = `turn ${turn} call ${i + 1}`;
      insert.run(
        SESSION_ID,
        ++at,
        "tool-start",
        tool,
        `demo-${call}`,
        JSON.stringify({ command: `echo "${detail}"`, path: `src/demo/turn-${turn}/file-${i}.ts` }),
        null,
        null,
      );
      insert.run(SESSION_ID, ++at, "tool-end", tool, `demo-${call}`, null, detail, null);
    }
    insert.run(
      SESSION_ID,
      ++at,
      "step-end",
      null,
      null,
      null,
      null,
      `Turn ${turn} of ${TURNS} done — demo harness transcript marker.`,
    );
    insert.run(SESSION_ID, ++at, "end", null, null, null, null, null);
  }
});
seed();

const rows = sqlite
  .prepare("select count(*) as n from harness_events where session_id = ?")
  .get(SESSION_ID);
console.log(`seeded: ${dbPath} (${SESSION_ID}, ${rows.n} harness events)`);
