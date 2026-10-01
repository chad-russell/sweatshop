import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { db } from "../../db";
import { getRun, getStageRun, parseVisitToken } from "../../db/machines";
import { sessionMachineVisit } from "../../lib/session-attributes";

/**
 * 0009: an eve stage of a machine run ends by calling `transition`.
 * Offered ONLY in sessions created as a machine stage (the
 * x-sweatshop-machine-visit principal attribute); every other
 * conversation never sees it, and single-target stages don't either —
 * they advance when the turn completes (agent/hooks/mirror.ts). The
 * target enum is exactly the stage's allowed next stages. The workflow
 * lives in the Next process, so the tool resumes it over the
 * same-container HTTP route rather than the hook API directly.
 */
export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      const token = sessionMachineVisit(ctx.session);
      const visit = token ? parseVisitToken(token) : null;
      if (!visit) return null;
      const run = getRun(db(), visit.runId);
      const row = getStageRun(db(), visit.runId, visit.seq);
      const stage = row ? run.definition.stages[row.stageId] : undefined;
      if (!stage) return null;
      // Only branching stages need the tool: single-target eve stages
      // advance on their own when the turn completes (agent/hooks/mirror).
      if (stage.next.length < 2) return null;
      const targets: string[] = stage.next.map((t) => t.to);
      const guide = stage.next.map((t) => `${t.to}${t.when ? ` (${t.when})` : ""}`).join("; ");
      const runId = visit.runId;
      const seq = visit.seq;
      return defineTool({
        description:
          "Finish your stage of this machine run and hand off to the next stage. " +
          "Call exactly once, only when your work for the stage is complete" +
          (guide ? `. Targets: ${guide}` : "") + ".",
        inputSchema: z.object({
          to: z.enum(targets as [string, ...string[]]),
          reason: z.string().max(2000),
        }),
        execute: async ({ to, reason }) => {
          const origin = process.env.SWEATSHOP_APP_ORIGIN ?? "http://127.0.0.1:3000";
          const res = await fetch(`${origin}/api/machine-runs/${runId}/visits/${seq}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ to, reason }),
          });
          const body = (await res.json().catch(() => ({}))) as { error?: string; to?: string };
          if (!res.ok) throw new Error(body.error ?? `transition failed (HTTP ${res.status})`);
          return { ok: true, next: body.to };
        },
      });
    },
  },
});
