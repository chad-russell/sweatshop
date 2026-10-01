import { parseVisitToken } from "../../db/machines";

/**
 * 0009: advance a single-target eve stage when its turn completes. The
 * mirror hook (eve runtime process) calls this on `turn.completed` for
 * sessions carrying a machine-visit attribute; the workflow lives in the
 * Next process, so this goes over the same-container HTTP route. The
 * route ignores visits that are not running eve stages (e.g. a branching
 * stage that already transitioned via its tool, or a branching stage
 * that has not chosen yet — that one needs the `transition` tool and
 * gets a 400 here, which is the correct no-op).
 *
 * Failsafe like the mirror: stable [machines] prefix, never throws.
 */
export function scheduleEveStageAdvance(token: string): void {
  const visit = parseVisitToken(token);
  if (!visit) return;
  const origin = process.env.SWEATSHOP_APP_ORIGIN ?? "http://127.0.0.1:3000";
  void fetch(`${origin}/api/machine-runs/${visit.runId}/visits/${visit.seq}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ auto: true }),
  })
    .then(async (res) => {
      if (!res.ok && res.status !== 400 && res.status !== 409) {
        console.error("[machines] eve stage advance failed", token, res.status, await res.text());
      }
    })
    .catch((err) => console.error("[machines] eve stage advance failed", token, err));
}
