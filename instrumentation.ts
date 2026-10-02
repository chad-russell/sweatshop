/**
 * 0013: the in-app sandbox reaper timer. Next calls `register` once per
 * server process; the reaper runs a pass shortly after boot (catching up
 * on anything that went idle while the server was down) and then every
 * few minutes. Node runtime only (it shells out to the container
 * engine). `SANDBOX_REAPER=off` disables it (tests, one-off scripts).
 */

const INTERVAL_MS = 5 * 60_000;
const FIRST_PASS_MS = 30_000;

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.SANDBOX_REAPER === "off") return;
  // One timer per process, even if register runs again (dev reloads).
  const key = Symbol.for("sweatshop.sandboxReaper");
  const g = globalThis as { [k: symbol]: unknown };
  if (g[key]) return;

  const pass = async () => {
    try {
      const { reap } = await import("./lib/sandboxes/reaper");
      const report = await reap({ apply: true });
      const acted = report.actions.filter((a) => a.action !== "skip-busy");
      if (acted.length > 0 || report.errors.length > 0) {
        console.log(
          `[sandbox-reaper] ${acted.map((a) => `${a.action} ${a.sandboxId}`).join(", ") || "nothing"}` +
            (report.errors.length ? `; errors: ${report.errors.map((e) => `${e.sandboxId}: ${e.error}`).join("; ")}` : ""),
        );
      }
    } catch (err) {
      console.error("[sandbox-reaper] pass failed", err);
    }
  };
  console.log(`[sandbox-reaper] every ${INTERVAL_MS / 60_000} min (first pass in ${FIRST_PASS_MS / 1000}s)`);
  const first = setTimeout(pass, FIRST_PASS_MS);
  const every = setInterval(pass, INTERVAL_MS);
  first.unref();
  every.unref();
  g[key] = every;
}
