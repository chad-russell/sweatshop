/**
 * 0005 harness visibility: in-process event buffers per conversation,
 * filled by HarnessAgent callbacks and served by
 * GET /api/harness/[sessionId]. Bounded per conversation. Buffers live
 * with the dev server; durable harness logs can mirror these later.
 */
export interface HarnessEvent {
  readonly at: number;
  readonly kind:
    | "start"
    | "step-start"
    | "tool-start"
    | "tool-end"
    | "step-end"
    | "end";
  readonly toolName?: string;
  readonly input?: string;
  readonly output?: string;
  readonly text?: string;
}

const MAX_PER_KEY = 500;
const buffers = new Map<string, HarnessEvent[]>();

function clip(value: unknown, max = 2000): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function recordHarnessEvent(
  key: string,
  event: Omit<HarnessEvent, "at">,
): void {
  const list = buffers.get(key) ?? [];
  list.push({ at: Date.now(), ...event });
  if (list.length > MAX_PER_KEY) list.splice(0, list.length - MAX_PER_KEY);
  buffers.set(key, list);
}

export function getHarnessEvents(key: string): readonly HarnessEvent[] {
  return buffers.get(key) ?? [];
}

export const clipHarnessText = clip;
