import { unwrapShell } from "@/lib/harness-timeline";
import { descriptionOf, parseBash } from "./bash";
import { inspectName, inspectOf, inspectState, oneLine } from "./inspect";
import { field, objectOf } from "./fields";

/**
 * Folding a turn's quiet, read-only tool calls into one expandable group
 * so the transcript reads as a history ("ran 4 commands, checked a chat
 * ×22") instead of a wall of identical cards. Pure — the transcript
 * renders what this returns and nothing is stored: the persisted rows
 * and the stream are untouched.
 *
 * What groups is an ALLOW-LIST (QUIET_TOOLS): a tool that asks Chad
 * something, changes something, or is evidence (approvals, create_pr,
 * plans, screenshots, harness calls, threads, previews …) is never
 * folded away, and any assistant text ends a run — the group is the
 * work between two things worth reading.
 */

export interface PartLike {
  type: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  toolCallId?: string;
  text?: string;
}

/** Tool → how a count of its calls reads in a group header. */
const QUIET_TOOLS: Record<string, { one: string; many: string }> = {
  bash: { one: "ran 1 command", many: "ran {n} commands" },
  sandbox_exec: { one: "ran 1 command", many: "ran {n} commands" },
  read: { one: "read 1 file", many: "read {n} files" },
  grep: { one: "searched files", many: "searched files ×{n}" },
  glob: { one: "searched files", many: "searched files ×{n}" },
  find: { one: "searched files", many: "searched files ×{n}" },
  ls: { one: "searched files", many: "searched files ×{n}" },
  gh: { one: "queried GitHub", many: "queried GitHub ×{n}" },
  forgejo: { one: "queried Forgejo", many: "queried Forgejo ×{n}" },
  inspect: { one: "checked 1 chat", many: "checked {n} times" },
  preview_status: { one: "checked previews", many: "checked previews ×{n}" },
  get_preview_setup: { one: "read the preview setup", many: "read the preview setup ×{n}" },
  list_projects: { one: "listed projects", many: "listed projects ×{n}" },
  system_docs: { one: "read 1 doc", many: "read {n} docs" },
  use_skill: { one: "loaded a skill", many: "loaded skills ×{n}" },
  web_search: { one: "searched the web", many: "searched the web ×{n}" },
  web_fetch: { one: "fetched 1 page", many: "fetched {n} pages" },
};

/** Tools whose repeats are polling: identical consecutive calls fold to one entry. */
const POLL_TOOLS = new Set(["inspect", "preview_status", "get_preview_setup", "list_projects"]);

/** A run needs at least this many calls before it becomes a group. */
export const MIN_GROUP = 3;

export const toolName = (part: PartLike): string => part.type.replace(/^tool-/, "");

const isTool = (part: PartLike) => part.type.startsWith("tool-");

/** Parts that render nothing, so they neither break nor join a run. */
function transparent(part: PartLike): boolean {
  if (part.type === "text") return (part.text ?? "").trim() === "";
  return !isTool(part);
}

export function isQuiet(part: PartLike): boolean {
  if (!isTool(part) || !(toolName(part) in QUIET_TOOLS)) return false;
  // A call waiting on (or answering) an approval must stay visible.
  return part.state !== "approval-requested" && part.state !== "approval-responded";
}

export type CallState = "running" | "ok" | "failed";

/** These tools' output is the thing itself — file content, a directory
 *  listing, matches — never a `{ok, ...}` / `{kind:"error"}` result
 *  envelope. A file that happens to contain that shape (JSON fixtures,
 *  error logs) must not read as a failed call. */
const RAW_OUTPUT_TOOLS = new Set(["read", "grep", "glob", "find", "ls"]);

export function callState(part: PartLike): CallState {
  if (part.state === "output-error" || part.state === "output-denied") return "failed";
  if (part.state === "output-available") {
    const name = toolName(part);
    if (!RAW_OUTPUT_TOOLS.has(name)) {
      const o = objectOf(part.output);
      if (o?.ok === false || o?.kind === "error") return "failed";
    }
    // bash / sandbox_exec report failure as a non-zero exit code.
    if ((name === "bash" || name === "sandbox_exec") && parseBash(part.input, part.output).exitCode) return "failed";
    return "ok";
  }
  return "running";
}

/** A group's history is not the task's verdict; only individual calls fail. */
export function groupStatus(group: Pick<ToolGroup, "running" | "failed">): {
  tone: "running" | "warn" | "ok";
  label: string;
} {
  const live = group.running > 0;
  const label = live ? "running" : "completed";
  const failures = group.failed > 0 ? ` · ${group.failed} failed ${group.failed === 1 ? "call" : "calls"}` : "";
  return { tone: live ? "running" : group.failed > 0 ? "warn" : "ok", label: label + failures };
}

/** One line for a call: the command, the id, the query — what it was ABOUT. */
export function callLabel(part: PartLike): string {
  const name = toolName(part);
  const i = objectOf(part.input);
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  let label: string | undefined;
  switch (name) {
    case "bash":
    case "sandbox_exec": {
      // The caller's own "what this is for" beats the command's first line.
      const cmd = field(part.input, "command", "cmd")?.value;
      label = descriptionOf(part.input) ?? (cmd ? unwrapShell(cmd).split("\n").find((l) => l.trim()) : undefined);
      break;
    }
    case "read":
      label = field(part.input, "file_path", "path", "filePath")?.value;
      break;
    case "ls":
      label = field(part.input, "path")?.value ?? ".";
      break;
    case "grep":
    case "glob":
    case "find":
      label = field(part.input, "pattern")?.value;
      break;
    case "inspect": {
      // What was inspected and where it stands — the id alone says nothing.
      const view = inspectOf(part.output);
      label = view ? `${oneLine(inspectName(view), 64)} · ${inspectState(view)}` : str(i?.id);
      break;
    }
    case "gh":
      label = Array.isArray(i?.args) ? `gh ${(i.args as unknown[]).filter((a) => typeof a === "string").join(" ")}` : undefined;
      break;
    case "forgejo":
      label = str(i?.path);
      break;
    case "web_search":
      label = str(i?.query);
      break;
    case "web_fetch":
      label = str(i?.url);
      break;
    case "system_docs":
      label = str(i?.topic);
      break;
    case "use_skill":
      label = str(i?.id);
      break;
    case "get_preview_setup":
      label = "Read preview setup";
      break;
    case "list_projects":
      label = "List projects";
      break;
    case "preview_status":
      label = "Check previews";
      break;
  }
  return (label ?? name).replace(/\s+/g, " ").trim();
}

/** The identity of a poll: same tool, same arguments. */
function signature(part: PartLike): string | undefined {
  const name = toolName(part);
  if (!POLL_TOOLS.has(name)) return undefined;
  return `${name}:${JSON.stringify(part.input ?? null)}`;
}

export interface GroupEntry {
  /** The call to draw — for a folded poll, the LATEST one. */
  part: PartLike;
  /** Its index in the message's parts (a stable React key). */
  index: number;
  /** Index of the FIRST call it stands for — stable while the poll folds. */
  key: number;
  /** How many identical consecutive calls this entry stands for. */
  count: number;
}

export interface ToolGroup {
  kind: "group";
  entries: GroupEntry[];
  /** Underlying call count (a folded poll counts every call). */
  calls: number;
  failed: number;
  running: number;
  /** "ran 4 commands · checked 1 chat ×22" */
  summary: string;
  /** The call to name in the header while live, else the first failure. */
  focus: PartLike;
  index: number;
}

export type Segment = { kind: "part"; part: PartLike; index: number } | ToolGroup;

function phrase(name: string, n: number, polled: boolean): string {
  const p = QUIET_TOOLS[name]!;
  const text = (n === 1 ? p.one : p.many).replace("{n}", String(n));
  // A poll repeated many times reads as a count, not "checked 22 times times".
  return polled && n > 1 && name === "inspect" ? `checked chats ×${n}` : text;
}

function summarize(entries: GroupEntry[]): string {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const e of entries) {
    const name = toolName(e.part) === "sandbox_exec" ? "bash" : toolName(e.part);
    if (!counts.has(name)) order.push(name);
    counts.set(name, (counts.get(name) ?? 0) + e.count);
  }
  return order.map((name) => phrase(name, counts.get(name)!, POLL_TOOLS.has(name))).join(" · ");
}

function buildGroup(run: { part: PartLike; index: number }[]): ToolGroup {
  const entries: GroupEntry[] = [];
  for (const item of run) {
    const prev = entries[entries.length - 1];
    const sig = signature(item.part);
    if (prev && sig !== undefined && signature(prev.part) === sig) {
      // Same poll again: keep the newest result, count the repeat.
      prev.part = item.part;
      prev.index = item.index;
      prev.count += 1;
    } else {
      entries.push({ part: item.part, index: item.index, key: item.index, count: 1 });
    }
  }
  const states = run.map((r) => callState(r.part));
  const failedIdx = states.indexOf("failed");
  const live = states.lastIndexOf("running");
  const focusItem = live >= 0 ? run[live]! : failedIdx >= 0 ? run[failedIdx]! : run[run.length - 1]!;
  return {
    kind: "group",
    entries,
    calls: run.length,
    failed: states.filter((s) => s === "failed").length,
    running: states.filter((s) => s === "running").length,
    summary: summarize(entries),
    focus: focusItem.part,
    index: run[0]!.index,
  };
}

/** Split a message's parts into plain parts and groups of quiet calls. */
export function groupParts(parts: readonly PartLike[]): Segment[] {
  const out: Segment[] = [];
  let run: { part: PartLike; index: number }[] = [];
  const flush = () => {
    if (run.length >= MIN_GROUP) out.push(buildGroup(run));
    else for (const r of run) out.push({ kind: "part", part: r.part, index: r.index });
    run = [];
  };
  parts.forEach((part, index) => {
    if (transparent(part)) return;
    if (isQuiet(part)) {
      run.push({ part, index });
      return;
    }
    flush();
    out.push({ kind: "part", part, index });
  });
  flush();
  return out;
}
