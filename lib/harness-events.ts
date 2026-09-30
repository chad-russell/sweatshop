import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { harnessEvents, harnessRuns } from "@/db/schema";

/**
 * 0005 harness visibility: pi/harness events per conversation, stored in
 * sqlite — the eve runtime writes, the Next server reads (WAL is the
 * cross-process transport), and the log is durable.
 */
export interface HarnessEvent {
  readonly id: number;
  readonly at: number;
  readonly kind:
    | "start"
    | "step-start"
    | "tool-start"
    | "tool-end"
    | "step-end"
    | "end";
  readonly toolName?: string | null;
  readonly input?: string | null;
  readonly output?: string | null;
  readonly text?: string | null;
}

function clip(value: unknown, max = 2000): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function recordHarnessEvent(
  sessionId: string,
  event: Omit<HarnessEvent, "id" | "at">,
): void {
  db()
    .insert(harnessEvents)
    .values({
      sessionId,
      at: Date.now(),
      kind: event.kind,
      toolName: event.toolName ?? null,
      input: event.input ?? null,
      output: event.output ?? null,
      text: event.text ?? null,
    })
    .run();
}

export function getHarnessEvents(sessionId: string): readonly HarnessEvent[] {
  return db()
    .select()
    .from(harnessEvents)
    .where(eq(harnessEvents.sessionId, sessionId))
    .orderBy(asc(harnessEvents.id))
    .limit(1000)
    .all() as HarnessEvent[];
}

export const clipHarnessText = clip;

/** Harness run index (harness_runs): status for the UI + /h validity. */
export function recordHarnessRunStart(sessionId: string, kind: string): void {
  const now = Date.now();
  db()
    .insert(harnessRuns)
    .values({
      sessionId,
      kind,
      status: "running",
      startedAt: now,
      lastAt: now,
    })
    .onConflictDoUpdate({
      target: harnessRuns.sessionId,
      set: { status: "running", lastAt: now },
    })
    .run();
}

export function recordHarnessRunEnd(
  sessionId: string,
  kind: string,
  toolCalls: number,
): void {
  const now = Date.now();
  db()
    .insert(harnessRuns)
    .values({
      sessionId,
      kind,
      status: "completed",
      toolCalls,
      startedAt: now,
      lastAt: now,
    })
    .onConflictDoUpdate({
      target: harnessRuns.sessionId,
      set: { status: "completed", toolCalls, lastAt: now },
    })
    .run();
}

export interface HarnessRun {
  sessionId: string;
  kind: string;
  status: string;
  toolCalls: number;
  startedAt: number;
  lastAt: number;
}

export function getHarnessRun(sessionId: string): HarnessRun | null {
  return (
    (db()
      .query.harnessRuns.findFirst({ where: eq(harnessRuns.sessionId, sessionId) })
      .sync() as HarnessRun | undefined) ?? null
  );
}
