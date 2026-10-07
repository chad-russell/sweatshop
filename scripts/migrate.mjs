import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const dbPath = process.env.SWEATSHOP_DB ?? path.join(process.cwd(), "data", "sweatshop.db");
mkdirSync(path.dirname(dbPath), { recursive: true });

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("busy_timeout = 5000");
// 0031: migrations run with FKs OFF — sqlite's documented schema-change
// posture (dropping/renaming a parent table is impossible with them on,
// and drizzle's migrator wraps everything in one transaction where the
// pragma cannot be toggled). Integrity is enforced by the check below.
sqlite.pragma("foreign_keys = OFF");

migrate(drizzle(sqlite), { migrationsFolder: path.join(process.cwd(), "drizzle") });

const violations = sqlite.prepare("PRAGMA foreign_key_check").all();
if (violations.length > 0) {
  throw new Error(`foreign key violations after migrate: ${JSON.stringify(violations.slice(0, 5))}`);
}
sqlite.pragma("foreign_keys = ON");

console.log(`migrated: ${dbPath}`);
