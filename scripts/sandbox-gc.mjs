import { execFileSync } from "node:child_process";

/**
 * 0004 sandbox hygiene: reap idle eve-sbx containers (age-based).
 *
 * Findings that shaped this (2026-09-30 experiments):
 * - Stopping a session's container is NOT a transparent pause: the next
 *   sandbox access re-runs the selector into a NEW container. Uncommitted
 *   worktree state on the old container is orphaned; anything committed
 *   and pushed survives (git is the durable state).
 * - Container names carry no session id (sha256 mapping tested and
 *   ruled out; no env labels), so per-session cleanup isn't possible —
 *   age is the honest signal.
 *
 * Default reap age: 24h of container age. Dry-run prints what would go.
 *   node scripts/sandbox-gc.mjs            (dry run)
 *   GC_APPLY=1 node scripts/sandbox-gc.mjs (remove)
 */
const AGE_HOURS = Number(process.env.GC_AGE_HOURS ?? 24);
const APPLY = process.env.GC_APPLY === "1";

// Inside the dev container the daemon is reached via the docker CLI
// (podman socket at /var/run/docker.sock); on the host, via podman.
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

const containers = podman("ps", "-a", "--format", "{{.Names}}")
  .split("\n")
  .filter((name) => name.startsWith("eve-sbx-"));

if (containers.length === 0) {
  console.log("sandbox-gc: no eve-sbx containers.");
  process.exit(0);
}

const cutoff = Date.now() - AGE_HOURS * 3_600_000;
let reaped = 0;
for (const name of containers) {
  const state = podman("inspect", name, "--format", "{{.State.Status}}");
  const startedAt = podman("inspect", name, "--format", "{{.State.StartedAt}}");
  const started = startedAt ? Date.parse(startedAt) : 0;
  const ageHours = started ? (Date.now() - started) / 3_600_000 : Infinity;
  if (started < cutoff) {
    console.log(
      `${APPLY ? "reaping" : "would reap"} ${name} (${state}, age ${ageHours.toFixed(1)}h)`,
    );
    if (APPLY) podman("rm", "-f", name);
    reaped += 1;
  } else {
    console.log(`keeping  ${name} (${state}, age ${ageHours.toFixed(1)}h)`);
  }
}
console.log(
  `sandbox-gc: ${reaped} ${reaped === 1 ? "container" : "containers"} ${APPLY ? "reaped" : "eligible"} (cutoff ${AGE_HOURS}h)`,
);
