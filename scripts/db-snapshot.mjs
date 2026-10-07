/**
 * Consistent point-in-time copy of the app database (0020), safe while
 * the server is running: better-sqlite3's online backup API copies a
 * transactionally consistent image, WAL included.
 *
 *   node scripts/db-snapshot.mjs <name>        → data/backups/<name>.db
 *   SNAPSHOT_KEEP=10 node scripts/db-snapshot.mjs pre-<sha>
 *
 * Used by scripts/deploy.sh (pre-<sha>, before migrating) and the
 * nightly user timer in cn (nightly, ahead of restic). With
 * SNAPSHOT_KEEP set, only the newest N snapshots sharing the name's
 * prefix (the part before the first "-", e.g. "pre") are kept.
 */
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const name = process.argv[2];
if (!name || !/^[\w.-]+$/.test(name)) {
  console.error("usage: node scripts/db-snapshot.mjs <name>   (letters, digits, . _ -)");
  process.exit(2);
}

const dbPath = process.env.SWEATSHOP_DB ?? path.join(process.cwd(), "data", "sweatshop.db");
const dir = path.join(path.dirname(dbPath), "backups");
mkdirSync(dir, { recursive: true });

const target = path.join(dir, `${name}.db`);
const partial = `${target}.partial`;
rmSync(partial, { force: true });

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
try {
  await db.backup(partial);
} finally {
  db.close();
}
// Rename last so a crash never leaves a truncated file under the real name.
renameSync(partial, target);
console.log(`snapshot: ${target} (${statSync(target).size} bytes)`);

const keep = Number(process.env.SNAPSHOT_KEEP ?? 0);
if (keep > 0) {
  const prefix = `${name.split("-")[0]}-`;
  const old = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".db"))
    .map((f) => ({ f, t: statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(keep);
  for (const { f } of old) {
    rmSync(path.join(dir, f));
    console.log(`snapshot: pruned ${f}`);
  }
}
