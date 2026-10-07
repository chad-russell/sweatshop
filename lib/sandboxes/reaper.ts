import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { LIVE_STATUSES } from "@/db/machines";
import {
  listPreviewsForSandboxes,
  markSandboxPreviewsStopped,
  previewActivityAt,
  RUNNING_PREVIEW_STATUSES,
} from "@/db/previews";
import { deleteLease, getLease, markDestroyed, updateLease } from "@/db/sandboxes";
import { conversations, harnessRuns, machineRuns, sandboxes } from "@/db/schema";
import { sandboxProvider, type SandboxProvider } from "@/lib/sandboxes/provider";
import { destroySandboxServices, stopSandboxServices } from "@/lib/sandboxes/services";

/**
 * 0013: sandbox lifecycle beyond the run — the one reaper (the in-app
 * timer, "Run cleanup now", and `npm run sandbox:gc` all call `reap`)
 * plus the manual per-sandbox Stop / Destroy.
 *
 * 0031: ONE window for every owner kind (stop 30m, destroy 7d,
 * env-overridable) — the per-kind split never earned its keep. A destroyed
 * sandbox's row is MARKED destroyed, never deleted (0011 — recorded
 * calls keep their target). A sandbox someone is actively working in is
 * never stopped or destroyed, however stale its last-use stamp.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;

export interface ReapWindows {
  stopMs: number;
  destroyMs: number;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 0031: one window — idle stop and final destroy, env-overridable. */
export function reapWindows(): ReapWindows {
  return {
    stopMs: envNumber("GC_STOP_MINUTES", 30) * MINUTE,
    destroyMs: envNumber("GC_DESTROY_DAYS", 7) * DAY,
  };
}

/** 0016: a serving preview with no proxied traffic for this long is stopped. */
export function previewIdleMs(): number {
  return envNumber("GC_PREVIEW_STOP_HOURS", 12) * 60 * MINUTE;
}

/** A "creating" row older than this never finished (crash mid-create). */
const STALE_CREATING_MS = 10 * MINUTE;

export interface ReapAction {
  sandboxId: string;
  action: "stop" | "destroy" | "drop-stale" | "skip-busy" | "stop-preview";
  ownerKind: string;
  idleMs: number;
}

export interface ReapReport {
  apply: boolean;
  actions: ReapAction[];
  errors: { sandboxId: string; error: string }[];
}

/**
 * Sandboxes with live work in them: an active chat turn or harness run
 * in a conversation bound to it (owner or attached), a live run
 * (running / waiting at a gate) bound to it, or (0016) a preview
 * starting or serving in it.
 */
export function busySandboxIds(ids: string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const busy = new Set<string>();
  const bound = db()
    .select({ id: conversations.id, sandboxId: conversations.sandboxId, activeRunId: conversations.activeRunId })
    .from(conversations)
    .where(inArray(conversations.sandboxId, ids))
    .all();
  for (const c of bound) if (c.activeRunId && c.sandboxId) busy.add(c.sandboxId);
  const sessions = bound.map((c) => c.id);
  if (sessions.length > 0) {
    const running = db()
      .select({ sessionId: harnessRuns.sessionId })
      .from(harnessRuns)
      .where(and(inArray(harnessRuns.sessionId, sessions), eq(harnessRuns.status, "running")))
      .all();
    const bySession = new Map(bound.map((c) => [c.id, c.sandboxId]));
    for (const r of running) {
      const sandboxId = bySession.get(r.sessionId);
      if (sandboxId) busy.add(sandboxId);
    }
  }
  for (const r of db()
    .select({ sandboxId: machineRuns.sandboxId, status: machineRuns.status })
    .from(machineRuns)
    .where(inArray(machineRuns.sandboxId, ids))
    .all()) {
    if (r.sandboxId && LIVE_STATUSES.has(r.status)) busy.add(r.sandboxId);
  }
  for (const p of listPreviewsForSandboxes(db(), ids)) {
    if (RUNNING_PREVIEW_STATUSES.includes(p.status)) busy.add(p.sandboxId);
  }
  return busy;
}

/**
 * One reaping pass. `apply: false` reports what would happen. Provider
 * failures are collected per sandbox (one stuck container never blocks
 * the rest).
 */
export async function reap(
  options: { apply: boolean; now?: number; provider?: SandboxProvider } = { apply: true },
): Promise<ReapReport> {
  const now = options.now ?? Date.now();
  const provider = options.provider ?? sandboxProvider();
  const report: ReapReport = { apply: options.apply, actions: [], errors: [] };

  // 0016: idle previews first — stopping one can free its sandbox for
  // the windows below in this same pass.
  await reapIdlePreviews(now, options.apply, report, provider);

  const rows = db()
    .select()
    .from(sandboxes)
    .where(
      or(
        eq(sandboxes.status, "running"),
        eq(sandboxes.status, "stopped"),
        eq(sandboxes.status, "creating"),
      ),
    )
    .all();
  const busy = busySandboxIds(rows.map((r) => r.id));

  for (const row of rows) {
    const idleMs = now - row.lastUsedAt;
    const base = { sandboxId: row.id, ownerKind: row.ownerKind, idleMs };
    if (row.status === "creating") {
      if (idleMs > STALE_CREATING_MS) {
        report.actions.push({ ...base, action: "drop-stale" });
        if (options.apply) deleteLease(db(), row.id);
      }
      continue;
    }
    const window = reapWindows();
    const due =
      idleMs > window.destroyMs
        ? "destroy"
        : row.status === "running" && idleMs > window.stopMs
          ? "stop"
          : null;
    if (!due) continue;
    if (busy.has(row.id)) {
      report.actions.push({ ...base, action: "skip-busy" });
      continue;
    }
    report.actions.push({ ...base, action: due });
    if (!options.apply) continue;
    try {
      if (due === "destroy") {
        await destroySandboxServices(row.id).catch(() => undefined);
        await provider.destroy(row.ref);
        markDestroyed(db(), row.id);
      } else {
        await stopSandboxServices(row.id).catch(() => undefined);
        await provider.stop(row.ref);
        updateLease(db(), row.id, { status: "stopped" });
      }
      markSandboxPreviewsStopped(db(), row.id);
    } catch (err) {
      report.errors.push({ sandboxId: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}

export class SandboxActionError extends Error {
  constructor(
    readonly code: "not-found" | "busy" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

/** Manual Stop: idle a live sandbox now (state kept; the next open resumes it). */
export async function stopSandboxNow(id: string, provider: SandboxProvider = sandboxProvider()): Promise<void> {
  const lease = getLease(db(), id);
  if (!lease) throw new SandboxActionError("not-found", `no sandbox ${id}`);
  if (lease.status === "stopped") return;
  if (lease.status !== "running") throw new SandboxActionError("invalid", `sandbox ${id} is ${lease.status}`);
  if (busySandboxIds([id]).has(id)) {
    throw new SandboxActionError("busy", "something is working in this sandbox right now — wait for it to finish");
  }
  await stopSandboxServices(id).catch(() => undefined);
  await provider.stop(lease.ref);
  updateLease(db(), id, { status: "stopped" });
  markSandboxPreviewsStopped(db(), id);
}

/**
 * Manual Destroy. Every chat or run bound to it keeps its binding (a
 * binding never changes) and must start fresh — the caller has warned.
 */
export async function destroySandboxNow(id: string, provider: SandboxProvider = sandboxProvider()): Promise<void> {
  const lease = getLease(db(), id);
  if (!lease) throw new SandboxActionError("not-found", `no sandbox ${id}`);
  if (lease.status === "destroyed") return;
  if (busySandboxIds([id]).has(id)) {
    throw new SandboxActionError("busy", "something is working in this sandbox right now — wait for it to finish");
  }
  await destroySandboxServices(id).catch(() => undefined);
  await provider.destroy(lease.ref);
  markDestroyed(db(), id);
  markSandboxPreviewsStopped(db(), id);
}

/**
 * 0016: stop previews nobody has opened for `GC_PREVIEW_STOP_HOURS`.
 * The process is killed through the preview service (the row goes
 * `stopped`); the sandbox is left to the ordinary windows.
 */
async function reapIdlePreviews(
  now: number,
  apply: boolean,
  report: ReapReport,
  provider: SandboxProvider,
): Promise<void> {
  const live = db()
    .select({ id: sandboxes.id, ownerKind: sandboxes.ownerKind })
    .from(sandboxes)
    .where(eq(sandboxes.status, "running"))
    .all();
  const kinds = new Map(live.map((s) => [s.id, s.ownerKind]));
  const idleAfter = previewIdleMs();
  for (const p of listPreviewsForSandboxes(db(), [...kinds.keys()])) {
    if (!RUNNING_PREVIEW_STATUSES.includes(p.status)) continue;
    const idleMs = now - previewActivityAt(p);
    if (idleMs <= idleAfter) continue;
    report.actions.push({ sandboxId: p.sandboxId, action: "stop-preview", ownerKind: kinds.get(p.sandboxId) ?? "?", idleMs });
    if (!apply) continue;
    try {
      const { stopPreview } = await import("@/lib/previews/service");
      await stopPreview(p.id, { provider });
    } catch (err) {
      report.errors.push({ sandboxId: p.sandboxId, error: `preview ${p.id}: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
}

/** Chats and runs bound to a sandbox (what Destroy strands). */
export function boundToSandbox(id: string): { conversations: number; runs: number } {
  const [c] = db()
    .select({ n: sql<number>`count(*)` })
    .from(conversations)
    .where(and(eq(conversations.sandboxId, id), sql`${conversations.kind} != 'run'`))
    .all();
  const [r] = db()
    .select({ n: sql<number>`count(*)` })
    .from(machineRuns)
    .where(eq(machineRuns.sandboxId, id))
    .all();
  return { conversations: c?.n ?? 0, runs: r?.n ?? 0 };
}
