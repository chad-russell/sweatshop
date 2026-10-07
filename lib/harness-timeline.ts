/**
 * Fold the flat harness_events rows (one row per stream event) into the
 * timeline the harness view renders: one item per tool call, with the
 * synthetic `fileChange` / `compaction` events attached or shown as
 * markers instead of as calls of their own. Pure and client-safe — no db.
 */

export interface TimelineEvent {
  id: number;
  kind: string;
  toolName?: string | null;
  toolCallId?: string | null;
  input?: string | null;
  output?: string | null;
  text?: string | null;
}

export interface FileChange {
  event: string;
  path: string;
}

export type TimelineItem =
  /** task: what the harness was asked (null on pre-2026-10-07 rows). */
  | { type: "turn-start"; id: number; task: string | null }
  | { type: "turn-end"; id: number }
  | { type: "text"; id: number; text: string }
  | {
      type: "tool";
      id: number;
      toolName: string;
      toolCallId: string | null;
      state: "running" | "completed" | "error";
      input: string | null;
      output: string | null;
      /** fileChange events that fired while this call was executing. */
      changes: FileChange[];
    }
  /** A fileChange with no write/edit call to attach to. */
  | { type: "file-change"; id: number; change: FileChange }
  | { type: "compaction"; id: number; detail: string | null };

type ToolItem = Extract<TimelineItem, { type: "tool" }>;

const SYNTHETIC = new Set(["fileChange", "compaction"]);

function parseJson(value: string | null | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function pathOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath"]) {
    if (typeof o[key] === "string") return o[key] as string;
  }
  return undefined;
}

function samePath(a: string, b: string): boolean {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/** Does this tool call's recorded input concern `path`? */
function touches(item: ToolItem, path: string): boolean {
  if (!item.input) return false;
  const own = pathOf(parseJson(item.input));
  if (own) return samePath(own, path);
  // Input was clipped mid-JSON — fall back to a substring match.
  return item.input.includes(path);
}

/**
 * Pairing: by toolCallId when recorded (0025+); older rows carry none, so
 * a tool-end pairs with the earliest still-open start of the same tool.
 */
export function buildTimeline(events: readonly TimelineEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const byCallId = new Map<string, ToolItem>();
  const openLegacy: ToolItem[] = [];

  const settle = (event: TimelineEvent, state: "completed" | "error") => {
    const name = event.toolName ?? "tool";
    let target: ToolItem | undefined;
    if (event.toolCallId) {
      target = byCallId.get(event.toolCallId);
    } else {
      const at = openLegacy.findIndex((t) => t.toolName === name);
      if (at >= 0) target = openLegacy.splice(at, 1)[0];
    }
    if (target) {
      target.state = state;
      target.output = event.output ?? null;
      return;
    }
    // End without a start (e.g. paged mid-call): show it as a finished call.
    items.push({
      type: "tool",
      id: event.id,
      toolName: name,
      toolCallId: event.toolCallId ?? null,
      state,
      input: null,
      output: event.output ?? null,
      changes: [],
    });
  };

  for (const event of events) {
    switch (event.kind) {
      case "start":
        items.push({ type: "turn-start", id: event.id, task: event.input || null });
        break;
      case "end":
        items.push({ type: "turn-end", id: event.id });
        break;
      case "step-end":
        if (event.text) items.push({ type: "text", id: event.id, text: event.text });
        break;
      case "tool-start": {
        const name = event.toolName ?? "?";
        if (name === "compaction") break; // rendered from its result
        if (name === "fileChange") {
          const raw = parseJson(event.input);
          const path = pathOf(raw);
          if (!path) break;
          const change: FileChange = {
            event: String((raw as { event?: unknown }).event ?? "change"),
            path,
          };
          // Prefer a still-running call on this path, else the most recent
          // call on it (the harness may report the change just after).
          const tools = items.filter((i): i is ToolItem => i.type === "tool");
          const target =
            [...tools].reverse().find((t) => t.state === "running" && touches(t, path)) ??
            [...tools].reverse().slice(0, 5).find((t) => touches(t, path));
          if (target) target.changes.push(change);
          else items.push({ type: "file-change", id: event.id, change });
          break;
        }
        const item: ToolItem = {
          type: "tool",
          id: event.id,
          toolName: name,
          toolCallId: event.toolCallId ?? null,
          state: "running",
          input: event.input ?? null,
          output: null,
          changes: [],
        };
        items.push(item);
        if (event.toolCallId) byCallId.set(event.toolCallId, item);
        else openLegacy.push(item);
        break;
      }
      case "tool-end":
      case "tool-error": {
        const name = event.toolName ?? "tool";
        if (name === "fileChange") break;
        if (name === "compaction") {
          items.push({ type: "compaction", id: event.id, detail: event.output ?? null });
          break;
        }
        settle(event, event.kind === "tool-error" ? "error" : "completed");
        break;
      }
      default:
        break; // step-start and unknown kinds carry nothing to show
    }
  }
  return items;
}

export function isSyntheticTool(name: string | null | undefined): boolean {
  return !!name && SYNTHETIC.has(name);
}

/**
 * One short line saying what a tool call is doing — the command for bash,
 * the path for file tools, else the first string argument. Input may be
 * clipped mid-JSON, so fall back to a regexp.
 */
export function toolBrief(input: string | null | undefined, max = 90): string {
  if (!input) return "";
  let text = "";
  const parsed = parseJson(input);
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    const pick = ["command", "path", "file_path", "filePath", "pattern", "query"]
      .map((k) => o[k])
      .find((v) => typeof v === "string") as string | undefined;
    text = pick ?? (Object.values(o).find((v) => typeof v === "string") as string | undefined) ?? "";
  } else {
    const m = /"(?:command|path|file_path|pattern)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(input);
    text = m ? m[1].replace(/\\n/g, " ").replace(/\\"/g, '"') : "";
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export interface HarnessActivity {
  /** Tool calls in the latest turn (synthetic events excluded). */
  toolCalls: number;
  /** The call in flight, if any. */
  current: { toolName: string; brief: string } | null;
  /** The most recent call (finished or not) — what to show between calls. */
  last: { toolName: string; brief: string } | null;
}

/** What a harness is doing right now, from the latest turn's events. */
export function summarizeActivity(events: readonly TimelineEvent[]): HarnessActivity {
  const items = buildTimeline(events);
  const turnAt = items.map((i) => i.type).lastIndexOf("turn-start");
  const tools = items.slice(turnAt + 1).filter((i): i is ToolItem => i.type === "tool");
  const describe = (t: ToolItem) => ({ toolName: t.toolName, brief: toolBrief(t.input) });
  const running = [...tools].reverse().find((t) => t.state === "running");
  const lastTool = tools[tools.length - 1];
  return {
    toolCalls: tools.length,
    current: running ? describe(running) : null,
    last: lastTool ? describe(lastTool) : null,
  };
}
