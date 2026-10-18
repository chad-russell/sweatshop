/**
 * In-process background work, started once per server process (Next
 * calls `register`; dev reloads may call it again, so each piece guards
 * itself with a global symbol). Node runtime only — both shell out to
 * the container engine — so instrumentation.ts imports this file only
 * under NEXT_RUNTIME === "nodejs" (keeps sqlite out of the edge bundle).
 *
 * - 0013 sandbox reaper: a pass shortly after boot (catching up on
 *   anything that went idle while the server was down), then every few
 *   minutes. `SANDBOX_REAPER=off` disables it.
 * - 0016 previews: the Host-routing proxy listener (`PREVIEW_PROXY_PORT`,
 *   default 3001 inside the container; `off` disables) and the
 *   reconcile/follow tick (every 30 s; `PREVIEW_TICK=off` disables).
 * - 0022 wake sweep: deliver run settles the in-run wake missed (every
 *   30 s; `WAKE_SWEEP=off` disables).
 * - 0050 codex: `CODEX_HOME` pointed at the app's harness-auth dir at
 *   boot, before the adapter first reads it.
 */

const REAP_INTERVAL_MS = 5 * 60_000;
const REAP_FIRST_PASS_MS = 30_000;
const PREVIEW_TICK_MS = 30_000;

type Globals = { [k: symbol]: unknown };

export async function registerNode() {
  const g = globalThis as Globals;
  // 0050: the codex adapter reads CODEX_HOME to find auth.json AND writes
  // token refreshes back there — pointing it at our data dir keeps the
  // operator's ~/.codex untouched. An existing CODEX_HOME wins.
  const { resolveCodexHome } = await import("./lib/harness-auth/codex");
  const codexHome = resolveCodexHome(process.env);
  if (codexHome) process.env.CODEX_HOME = codexHome;
  startReaper(g);
  await startPreviews(g);
}

function startReaper(g: Globals) {
  if (process.env.SANDBOX_REAPER === "off") return;
  const key = Symbol.for("sweatshop.sandboxReaper");
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
    // 0042: abandoned image uploads (unclaimed past 24 h) ride the same tick.
    try {
      const [{ db }, { sweepUnclaimed }, { removeAttachmentFiles }] = await Promise.all([
        import("./db"),
        import("./db/attachments"),
        import("./lib/attachments"),
      ]);
      const swept = sweepUnclaimed(db());
      await Promise.all(swept.map(removeAttachmentFiles));
      if (swept.length > 0) console.log(`[attachments] swept ${swept.length} abandoned upload(s)`);
    } catch (err) {
      console.error("[attachments] sweep failed", err);
    }
  };
  console.log(`[sandbox-reaper] every ${REAP_INTERVAL_MS / 60_000} min (first pass in ${REAP_FIRST_PASS_MS / 1000}s)`);
  const first = setTimeout(pass, REAP_FIRST_PASS_MS);
  const every = setInterval(pass, REAP_INTERVAL_MS);
  first.unref();
  every.unref();
  g[key] = every;
}

async function startPreviews(g: Globals) {
  const proxyPort = process.env.PREVIEW_PROXY_PORT ?? "3001";
  const proxyKey = Symbol.for("sweatshop.previewProxy");
  if (proxyPort !== "off" && !g[proxyKey]) {
    const { startPreviewProxy } = await import("./lib/previews/runtime");
    g[proxyKey] = startPreviewProxy(Number(proxyPort), process.env.SWEATSHOP_PUBLIC_ORIGIN);
  }

  const tickKey = Symbol.for("sweatshop.previewTick");
  if (process.env.PREVIEW_TICK !== "off" && !g[tickKey]) {
    const tick = async () => {
      const { previewTick } = await import("./lib/previews/runtime");
      await previewTick();
    };
    const every = setInterval(() => void tick(), PREVIEW_TICK_MS);
    every.unref();
    g[tickKey] = every;
  }

  startWakeSweep(g);
}

const WAKE_SWEEP_MS = 30_000;
const WAKE_SWEEP_FIRST_MS = 10_000;

/**
 * 0022: deliver run settles the in-run wake missed — crash/restart
 * recovery, and the tripwire for settles that happen without one.
 * `WAKE_SWEEP=off` disables.
 */
function startWakeSweep(g: Globals) {
  if (process.env.WAKE_SWEEP === "off") return;
  const key = Symbol.for("sweatshop.wakeSweep");
  if (g[key]) return;

  const sweep = async () => {
    try {
      const { sweepWakes } = await import("./lib/chat/wake");
      await sweepWakes();
    } catch (err) {
      console.error("[wake-sweep] pass failed", err);
    }
  };
  console.log(`[wake-sweep] every ${WAKE_SWEEP_MS / 1000}s (first pass in ${WAKE_SWEEP_FIRST_MS / 1000}s)`);
  const first = setTimeout(() => void sweep(), WAKE_SWEEP_FIRST_MS);
  const every = setInterval(() => void sweep(), WAKE_SWEEP_MS);
  first.unref();
  every.unref();
  g[key] = every;
}
