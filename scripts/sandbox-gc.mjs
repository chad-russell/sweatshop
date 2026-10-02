/**
 * Run the sandbox reaper now (0013) — a thin client of the running app,
 * which owns the one reaper (lib/sandboxes/reaper.ts; the app also runs
 * it on a timer from instrumentation.ts). Windows are per owner kind:
 * chats stop after 30 min idle / destroy after 14 days, runs 10 min /
 * 3 days (GC_* env vars on the app). Destroyed rows are kept as history.
 *
 *   npm run sandbox:gc            (dry run: report only)
 *   GC_APPLY=1 npm run sandbox:gc (apply)
 *
 * SWEATSHOP_URL defaults to http://sweatshop-dev:3000 — the dev server
 * by container name on the shared harness network, which is where
 * `./dev exec -- npm run sandbox:gc` runs. From the host use
 * SWEATSHOP_URL=http://localhost:3300.
 */
const base = process.env.SWEATSHOP_URL ?? "http://sweatshop-dev:3000";
const apply = process.env.GC_APPLY === "1";

const res = await fetch(`${base}/api/sandboxes/reap${apply ? "" : "?dry=1"}`, { method: "POST" }).catch(
  (err) => {
    console.error(`sandbox-gc: could not reach the app at ${base} (${err.message}) — is ./dev running?`);
    process.exit(1);
  },
);
if (!res.ok) {
  console.error(`sandbox-gc: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const report = await res.json();
for (const a of report.actions) {
  const idle =
    a.idleMs > 86_400_000 ? `${(a.idleMs / 86_400_000).toFixed(1)}d` : `${Math.round(a.idleMs / 60_000)}min`;
  const verb = a.action === "skip-busy" ? "skip (busy)" : apply ? a.action : `would ${a.action}`;
  console.log(`${verb} ${a.sandboxId} (${a.ownerKind}, idle ${idle})`);
}
for (const e of report.errors) console.error(`error ${e.sandboxId}: ${e.error}`);
const acted = report.actions.filter((a) => a.action !== "skip-busy").length;
console.log(`sandbox-gc: ${acted} ${acted === 1 ? "action" : "actions"} ${apply ? "applied" : "eligible"}`);
