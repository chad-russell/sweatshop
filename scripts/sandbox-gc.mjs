import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";

/**
 * Sandbox hygiene (0004 + 0010 Phase 2).
 *
 * 1. Lease reaping (the sandboxes registry): a running sandbox idle
 *    past its stop window is STOPPED (state preserved — resumed on the
 *    next open); one idle past its destroy window is destroyed and its
 *    row MARKED destroyed (0011: the row stays so recorded calls keep a
 *    target — never deleted). Windows depend on the owner (0013):
 *      conversation  30 min / 14 days  (GC_STOP_MINUTES / GC_DESTROY_DAYS)
 *      machine_run   10 min / 3 days   (GC_RUN_STOP_MINUTES / GC_RUN_DESTROY_DAYS)
 *    Stale "creating" rows (a crash between lease insert and provider
 *    create) never ran anything and are deleted outright.
 * 2. eve-sbx containers (0004): age-based reap until eve is deleted
 *    (0010 Phase 6). Container names carry no session id, so age is the
 *    honest signal there.
 *
 *   node scripts/sandbox-gc.mjs            (dry run)
 *   GC_APPLY=1 node scripts/sandbox-gc.mjs (apply)
 */
const MINUTE = 60_000;
const DAY = 86_400_000;
const WINDOWS = {
  conversation: {
    stop: Number(process.env.GC_STOP_MINUTES ?? 30) * MINUTE,
    destroy: Number(process.env.GC_DESTROY_DAYS ?? 14) * DAY,
  },
  machine_run: {
    stop: Number(process.env.GC_RUN_STOP_MINUTES ?? 10) * MINUTE,
    destroy: Number(process.env.GC_RUN_DESTROY_DAYS ?? 3) * DAY,
  },
};
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
  .prepare(
    "select id, ref, status, owner_kind, last_used_at from sandboxes where status in ('running','stopped')",
  )
  .all();
for (const lease of leases) {
  const idle = now - lease.last_used_at;
  const window = WINDOWS[lease.owner_kind] ?? WINDOWS.conversation;
  if (idle > window.destroy) {
    log("destroy", `${lease.id} (${lease.owner_kind} ${lease.ref}, idle ${(idle / DAY).toFixed(1)}d)`);
    if (APPLY) {
      try {
        podman("rm", "-f", lease.ref);
      } catch {
        // already gone
      }
      sqlite
        .prepare("update sandboxes set status = 'destroyed', destroyed_at = ? where id = ?")
        .run(now, lease.id);
    }
    actions += 1;
  } else if (lease.status === "running" && idle > window.stop) {
    log("stop", `${lease.id} (${lease.owner_kind} ${lease.ref}, idle ${(idle / MINUTE).toFixed(0)}min)`);
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
  `sandbox-gc: ${actions} lease ${actions === 1 ? "action" : "actions"}, ${reaped} eve ${reaped === 1 ? "container" : "containers"} ${APPLY ? "applied" : "eligible"} (chats stop >${WINDOWS.conversation.stop / MINUTE}min destroy >${WINDOWS.conversation.destroy / DAY}d; ` +
    `runs stop >${WINDOWS.machine_run.stop / MINUTE}min destroy >${WINDOWS.machine_run.destroy / DAY}d; eve >${EVE_AGE_HOURS}h)`,
);
