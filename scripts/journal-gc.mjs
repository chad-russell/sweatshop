/**
 * Delete settled workflow runs' durable journals (0076 follow-up).
 *
 * The local world persists EVERY stream chunk as its own file
 * (data/workflow-data/streams/chunks/<stream>/chnk_*.bin — one long
 * turn measured 750 MB / 192k files) plus per-event and per-step JSON
 * files, and never expires them. Display never reads a journal after
 * its run settles: sqlite rows are the transcript's source of truth,
 * and the journal exists only for mid-turn reconnects (0076 removed
 * even those for loaded pages). So a settled run's journal is dead
 * weight. This walks runs/*.json, keeps every non-settled run and the
 * newest --keep-days of settled ones, and deletes for each victim:
 *
 *   runs/<runId>.json             the run's materialized state (dead last)
 *   events/<runId>-evnt_*.json    the run's event log
 *   steps/<runId>-step_*.json     materialized steps
 *   streams/chunks/<streamId>/    chunk journals named by streams/runs/<runId>.json
 *   streams/runs/<runId>.json     the stream-name index
 *
 * Safety: dry run by default (GC_APPLY=1 deletes); a run with an
 * unreadable/missing status is skipped, never deleted; unknown age is
 * kept. Directories are enumerated lazily — chunk dirs hold hundreds
 * of thousands of entries.
 *
 *   node scripts/journal-gc.mjs             (dry run)
 *   GC_APPLY=1 node scripts/journal-gc.mjs  (apply)
 *   GC_KEEP_DAYS=14                          (default; 0 = every settled run)
 */
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const root = process.env.WORKFLOW_DATA_DIR ?? "data/workflow-data";
const apply = process.env.GC_APPLY === "1";
const keepDays = Number(process.env.GC_KEEP_DAYS ?? 14);
if (!Number.isFinite(keepDays) || keepDays < 0) {
  console.error("journal-gc: GC_KEEP_DAYS must be a number >= 0");
  process.exit(1);
}
const cutoff = keepDays === 0 ? -Infinity : Date.now() - keepDays * 86_400_000;
const SETTLED = new Set(["completed", "failed", "cancelled"]);

const sizeOf = async (p) => (await stat(p).catch(() => null))?.size ?? 0;
const sizeOfTree = async (p) => {
  const st = await stat(p).catch(() => null);
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const e of await readdir(p).catch(() => [])) total += await sizeOfTree(join(p, e));
  return total;
};

let names;
try {
  names = (await readdir(join(root, "runs"))).filter((n) => n.endsWith(".json"));
} catch {
  console.error(`journal-gc: no runs dir under ${root} — wrong WORKFLOW_DATA_DIR?`);
  process.exit(1);
}

// One lazy listing per shared dir, reused across victims.
const listDir = async (dir) => {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
};
const events = await listDir(join(root, "events"));
const steps = await listDir(join(root, "steps"));

let freed = 0;
let dropped = 0;
let kept = 0;
let skipped = 0;

for (const name of names) {
  const runId = name.slice(0, -5);
  let meta;
  try {
    meta = JSON.parse(await readFile(join(root, "runs", name), "utf8"));
  } catch {
    skipped += 1;
    continue; // unreadable — never guess
  }
  if (typeof meta.status !== "string" || !SETTLED.has(meta.status)) {
    kept += 1;
    continue; // live/pending/unknown — untouchable
  }
  const endedAt = Date.parse(meta.completedAt ?? meta.updatedAt ?? meta.createdAt ?? "");
  if (!Number.isFinite(endedAt) || endedAt > cutoff) {
    kept += 1;
    continue; // too fresh, or unknown age — keep
  }

  const eventFiles = events.filter((f) => f.startsWith(`${runId}-evnt_`));
  const stepFiles = steps.filter((f) => f.startsWith(`${runId}-step_`));
  let streamDirs = [];
  try {
    const idx = JSON.parse(await readFile(join(root, "streams", "runs", name), "utf8"));
    streamDirs = Array.isArray(idx.streams) ? idx.streams : [];
  } catch {
    /* no index — nothing named to delete; events/steps still go */
  }
  const victims = [
    ...eventFiles.map((f) => join(root, "events", f)),
    ...stepFiles.map((f) => join(root, "steps", f)),
    ...streamDirs.map((s) => join(root, "streams", "chunks", s)),
    join(root, "streams", "runs", name),
    join(root, "runs", name),
  ];

  if (apply) {
    for (const v of victims) await rm(v, { recursive: true, force: true });
  } else {
    for (const v of victims) freed += await sizeOfTree(v);
  }
  dropped += 1;
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
console.log(
  apply
    ? `journal-gc: dropped ${dropped} settled runs' journals (kept ${kept}; skipped ${skipped} unreadable)`
    : `journal-gc (dry): would drop ${dropped} settled runs' journals, freeing ~${mb(freed)} (kept ${kept}: live/newer than ${keepDays}d; skipped ${skipped} unreadable)`,
);
