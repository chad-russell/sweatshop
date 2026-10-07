import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

// Runs before the test file's imports: point the db layer at a fresh temp
// file and apply the real migrations — tests exercise the actual schema.
const dir = mkdtempSync(path.join(tmpdir(), "sweatshop-test-"));
process.env.SWEATSHOP_DB = path.join(dir, "test.db");

// Same for the workflow SDK's local world (0010 spike): an isolated data
// dir per worker, with no recovery of stale runs from other sessions.
process.env.WORKFLOW_LOCAL_DATA_DIR = path.join(dir, "workflow-data");
process.env.WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS = "0";

const sqlite = new Database(process.env.SWEATSHOP_DB);
sqlite.pragma("journal_mode = WAL");
// 0031: same migration posture as scripts/migrate.mjs — FKs off while
// applying (schema surgery), then assert integrity.
sqlite.pragma("foreign_keys = OFF");
migrate(drizzle(sqlite), {
  migrationsFolder: path.join(process.cwd(), "drizzle"),
});
const violations = sqlite.prepare("PRAGMA foreign_key_check").all();
if (violations.length > 0) {
  throw new Error(`foreign key violations in test schema: ${JSON.stringify(violations.slice(0, 5))}`);
}
sqlite.pragma("foreign_keys = ON");
