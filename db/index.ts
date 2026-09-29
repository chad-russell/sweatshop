import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export type Db = ReturnType<typeof openDb>;

function resolveDbPath(): string {
  return process.env.SWEATSHOP_DB ?? path.join(process.cwd(), "data", "sweatshop.db");
}

/** Open (and pragmatically configure) the sweatshop db at dbPath. */
export function openDb(dbPath: string = resolveDbPath()) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  // WAL + busy timeout: the Next server and the eve runtime both touch
  // this file from the same container.
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

let singleton: Db | null = null;

/** Process-wide connection (Next RSC + eve hook share one process under
 * withEve). Tests use openDb() against a temp path instead. */
export function db(): Db {
  singleton ??= openDb();
  return singleton;
}
