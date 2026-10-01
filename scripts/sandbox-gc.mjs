import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";

/**
 * Sandbox hygiene (0004 + 0010 Phase 2).
 *
 * 1. Lease reaping (the sandboxes registry): a running sandbox idle
 *    past STOP_AFTER is STOPPED (state preserved — resume on next
 *    acquire); a stopped sandbox idle past DESTROY_AFTER is destroyed
 *    and its row deleted. Stale "creating" rows (a crash between lease
 *    insert and provider create) are swept. Defaults per docs/0010:
 *    30 minutes / 14 days.
 * 2. eve-sbx containers (0004): age-based reap until eve is deleted
 *    (0010 Phase 6). Container names carry no session id, so age is the
 *    honest signal there.
 *
 *   node scripts/sandbox-gc.mjs            (dry run)
 *   GC_APPLY=1 node scripts/sandbox-gc.mjs (apply)
 */
const STOP_AFTER_MS = Number(process.env.GC_STOP_MINUTES ?? 30) * 60_000;
const DESTROY_AFTER_MS = Number(process.env.GC_DESTROY_DAYS ?? 14) * 86_400_000;
const EVE_AGE_HOURS = Number(process.env.GC_AGE_HOURS ?? 24);
const APPLY = process.env.GC_APPLY === "1";

function resolveEngine() {
  if (process.env.GC_ENGINE) return process.env.GC_ENGINE;
  try {
    execFileSync("docker", ["--version"], { encoding: "utf8", stdio: "ignore" });
    return "docker";
  } catch {
    return "podman";
  }
}
const ENGINE = resolveEngine();

function podman(...args) {
  return execFileSync(ENGINE, args, { encoding: "utf8" }).trim();
}

function log(verb, what) {
  console.log(`${APPLY ? verb : `would ${verb}`} ${what}`);
}

let actions = 0;

// --- 1. lease reaping ----------------------------------------------------
const dbPath =
  process.env.SWEATSHOP_DB ??
  new URL("../data/sweatshop.db", import.meta.url).pathname;
const sqlite = new Database(dbPath, { fileMustExist: false });
const now = Date.now();

const creating = sqlite
  .prepare("select id from sandboxes where status = 'creating'")
  .all();
for (const { id } of creating) {
  log("delete stale creating lease", id);
  if (APPLY) {
    sqlite.prepare("delete from sandbox_attachments where sandbox_id = ?").run(id);
    sqlite.prepare("delete from sandboxes where id = ?").run(id);
  }
  actions += 1;
}

const leases = sqlite
  .prepare("select id, ref, status, last_used_at from sandboxes where status in ('running','stopped')")
  .all();
for (const lease of leases) {
  const idle = now - lease.last_used_at;
  if (lease.status === "running" && idle > STOP_AFTER_MS) {
    log("stop", `${lease.id} (${lease.ref}, idle ${(idle / 60_000).toFixed(0)}min)`);
    if (APPLY) {
      try {
        podman("stop", lease.ref);
      } catch {
        // already gone — fall through to row cleanup below
      }
      sqlite
        .prepare("update sandboxes set status = 'stopped' where id = ?")
        .run(lease.id);
    }
    actions += 1;
  }
  if (idle > DESTROY_AFTER_MS) {
    log("destroy", `${lease.id} (${lease.ref}, idle ${(idle / 86_400_000).toFixed(1)}d)`);
    if (APPLY) {
      try {
        podman("rm", "-f", lease.ref);
      } catch {
        // already gone
      }
      sqlite.prepare("delete from sandbox_attachments where sandbox_id = ?").run(lease.id);
      sqlite.prepare("delete from sandboxes where id = ?").run(lease.id);
    }
    actions += 1;
  }
}

// --- 2. eve-sbx age reap (0004; retires with eve in Phase 6) -------------
const containers = podman("ps", "-a", "--format", "{{.Names}}")
  .split("\n")
  .filter((name) => name.startsWith("eve-sbx-"));

const eveCutoff = now - EVE_AGE_HOURS * 3_600_000;
let reaped = 0;
for (const name of containers) {
  const state = podman("inspect", name, "--format", "{{.State.Status}}");
  const startedAt = podman("inspect", name, "--format", "{{.State.StartedAt}}");
  const started = startedAt ? Date.parse(startedAt) : 0;
  const ageHours = started ? (now - started) / 3_600_000 : Infinity;
  if (started < eveCutoff) {
    log("reap", `${name} (${state}, age ${ageHours.toFixed(1)}h)`);
    if (APPLY) podman("rm", "-f", name);
    reaped += 1;
  } else {
    console.log(`keeping  ${name} (${state}, age ${ageHours.toFixed(1)}h)`);
  }
}

sqlite.close();
console.log(
  `sandbox-gc: ${actions} lease ${actions === 1 ? "action" : "actions"}, ${reaped} eve ${reaped === 1 ? "container" : "containers"} ${APPLY ? "applied" : "eligible"} (stop >${STOP_AFTER_MS / 60_000}min, destroy >${DESTROY_AFTER_MS / 86_400_000}d, eve >${EVE_AGE_HOURS}h)`,
);
