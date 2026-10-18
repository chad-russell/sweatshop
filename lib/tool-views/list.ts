import { field } from "./fields";

/** What the list-tool card (ls / grep / glob / find) draws. */

export type ListToolName = "ls" | "grep" | "glob" | "find";

export interface ListEntry {
  kind: "dir" | "file" | "match";
  path: string;
  line?: number;
  text?: string;
}

export interface ListView {
  tool: ListToolName;
  /** What was asked: the directory, or the pattern (and where). */
  arg: string;
  entries: ListEntry[];
  /** Harness notices such as "[100 entries limit reached]". */
  notes: string[];
  noun: { one: string; many: string };
}

export function parseListTool(tool: ListToolName, input: unknown, output: unknown): ListView {
  const path = field(input, "path")?.value;
  const pattern = field(input, "pattern")?.value;
  const arg =
    tool === "ls"
      ? (path ?? ".")
      : `${pattern ?? ""}${path && path !== "." ? ` in ${path}` : ""}`.trim();
  const entries: ListEntry[] = [];
  const notes: string[] = [];
  if (typeof output === "string") {
    for (const raw of output.split("\n")) {
      const line = raw.trimEnd();
      if (!line.trim()) continue;
      if (/^\[.*\]$/.test(line.trim())) {
        notes.push(line.trim().slice(1, -1));
        continue;
      }
      const match = tool === "grep" ? /^(.+?):(\d+)[:-](.*)$/.exec(line) : null;
      if (match) entries.push({ kind: "match", path: match[1]!, line: Number(match[2]), text: match[3]!.trim() });
      else entries.push({ kind: line.endsWith("/") ? "dir" : "file", path: line });
    }
  }
  const noun =
    tool === "ls"
      ? { one: "entry", many: "entries" }
      : tool === "grep"
        ? { one: "match", many: "matches" }
        : { one: "file", many: "files" };
  return { tool, arg, entries, notes, noun };
}
