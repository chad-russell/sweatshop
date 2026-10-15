import { HARNESS_OUTPUT_CLIP } from "./harness-limits";
import { field, numberField, objectOf } from "./tool-fields";

/**
 * What the file-tool cards (write / edit / read) draw. Both harnesses
 * normalise to `file_path` + `content` | `old_string`/`new_string`; claude's
 * write/edit output also carries a `structuredPatch` we render as a real
 * diff with line numbers. Anything clipped by the recorder is flagged.
 */

export type FileToolName = "write" | "edit" | "read";

export interface CodeLine {
  text: string;
  num: number;
}

export interface DiffLine {
  kind: "ctx" | "add" | "del" | "gap";
  text: string;
  /** Line number in the file after the change (before it, for deletions) — when known. */
  num?: number;
}

export interface FileToolView {
  tool: FileToolName;
  path: string;
  /** `src/lib/` — with its trailing slash, or "". */
  dir: string;
  base: string;
  language: string;
  code?: CodeLine[];
  diff?: DiffLine[];
  added: number;
  removed: number;
  /** For write: whether the file was created or overwritten, when known. */
  change?: "create" | "update";
  clipped: boolean;
  /** For read: the file's full length, when the harness said so and this is only part of it. */
  totalLines?: number;
}

const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", md: "markdown", py: "python", sh: "bash", bash: "bash", zsh: "bash",
  css: "css", html: "html", yml: "yaml", yaml: "yaml", sql: "sql", go: "go", rs: "rust",
  toml: "toml", nix: "nix", rb: "ruby", java: "java", c: "c", h: "c", cpp: "cpp", diff: "diff",
};

export function languageFor(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (/^(Dockerfile|Containerfile)/.test(base)) return "docker";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? (LANGUAGES[base.slice(dot + 1).toLowerCase()] ?? "text") : "text";
}

export function splitPath(path: string): { dir: string; base: string } {
  const at = path.lastIndexOf("/");
  return { dir: path.slice(0, at + 1), base: path.slice(at + 1) };
}

function toLines(text: string, start: number): CodeLine[] {
  if (text === "") return [];
  const parts = text.split("\n");
  if (text.endsWith("\n")) parts.pop();
  return parts.map((line, i) => ({ text: line, num: start + i }));
}

/** claude's `cat -n` style (`  12→text`) → real line numbers; plain text → numbered from `offset`. */
function readLines(output: string, offset: number): CodeLine[] {
  const raw = output.replace(/\n$/, "");
  if (raw === "") return [];
  const lines = raw.split("\n");
  const numbered = /^\s*\d+[→\t]/;
  if (lines.some((l) => l !== "") && lines.every((l) => l === "" || numbered.test(l))) {
    let prev = offset - 1;
    return lines.map((l) => {
      const m = /^\s*(\d+)[→\t](.*)$/.exec(l);
      prev = m ? Number(m[1]) : prev + 1;
      return { text: m ? m[2]! : "", num: prev };
    });
  }
  return lines.map((text, i) => ({ text, num: offset + i }));
}

/**
 * claude's Read result is an envelope, not the file's text:
 * `{"type":"text","file":{filePath,content,numLines,startLine,totalLines}}`.
 * Unwrap it to the content (and where it starts / how long the file is).
 * The recorder clips the whole JSON, so a long read no longer parses —
 * recover the content with `field` and flag it clipped. Other envelope types
 * (image, pdf, file_unchanged) carry no text to show and are not matched.
 * pi returns plain text and never matches.
 */
function unwrapReadEnvelope(
  output: string,
): { content: string; startLine?: number; totalLines?: number; partial: boolean; clipped: boolean } | undefined {
  if (!/^\s*\{"type"\s*:\s*"text"\s*,\s*"file"\s*:\s*\{/.test(output)) return undefined;
  const file = objectOf(objectOf(output)?.file);
  if (file) {
    if (typeof file.content !== "string") return undefined;
    const startLine = typeof file.startLine === "number" ? file.startLine : undefined;
    const totalLines = typeof file.totalLines === "number" ? file.totalLines : undefined;
    const numLines = typeof file.numLines === "number" ? file.numLines : undefined;
    return {
      content: file.content,
      startLine,
      totalLines,
      partial: totalLines !== undefined && numLines !== undefined && numLines < totalLines,
      clipped: false,
    };
  }
  const content = field(output, "content");
  return content ? { content: content.value, partial: false, clipped: content.clipped } : undefined;
}

function patchToDiff(patch: unknown): DiffLine[] | undefined {
  if (!Array.isArray(patch) || patch.length === 0) return undefined;
  const out: DiffLine[] = [];
  patch.forEach((hunk: unknown, i) => {
    const h = hunk as { oldStart?: unknown; newStart?: unknown; lines?: unknown };
    if (!h || !Array.isArray(h.lines)) return;
    if (i > 0) out.push({ kind: "gap", text: "" });
    let oldNum = Number(h.oldStart) || 1;
    let newNum = Number(h.newStart) || 1;
    for (const line of h.lines as string[]) {
      const tag = line[0];
      const text = line.slice(1);
      if (tag === "+") out.push({ kind: "add", text, num: newNum++ });
      else if (tag === "-") out.push({ kind: "del", text, num: oldNum++ });
      else if (tag === "\\") continue; // "\ No newline at end of file"
      else {
        out.push({ kind: "ctx", text, num: newNum });
        oldNum += 1;
        newNum += 1;
      }
    }
  });
  return out.length ? out : undefined;
}

function lcsDiff(a: string[], b: string[]): DiffLine[] {
  if (a.length * b.length > 160_000) {
    return [
      ...a.map((text) => ({ kind: "del" as const, text })),
      ...b.map((text) => ({ kind: "add" as const, text })),
    ];
  }
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "ctx", text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: "del", text: a[i]! });
      i += 1;
    } else {
      out.push({ kind: "add", text: b[j]! });
      j += 1;
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++]! });
  while (j < m) out.push({ kind: "add", text: b[j++]! });
  return out;
}

/** Line diff of two strings, trimmed to `context` unchanged lines around each change. */
export function diffStrings(before: string, after: string, context = 2): DiffLine[] {
  const A = before === "" ? [] : before.split("\n");
  const B = after === "" ? [] : after.split("\n");
  let head = 0;
  while (head < A.length && head < B.length && A[head] === B[head]) head += 1;
  let tail = 0;
  while (tail < A.length - head && tail < B.length - head && A[A.length - 1 - tail] === B[B.length - 1 - tail]) tail += 1;

  const ops: DiffLine[] = [];
  for (let i = 0; i < head; i += 1) ops.push({ kind: "ctx", text: A[i]! });
  ops.push(...lcsDiff(A.slice(head, A.length - tail), B.slice(head, B.length - tail)));
  for (let i = A.length - tail; i < A.length; i += 1) ops.push({ kind: "ctx", text: A[i]! });

  const near = ops.map((_, i) =>
    ops.slice(Math.max(0, i - context), i + context + 1).some((o) => o.kind !== "ctx"),
  );
  const out: DiffLine[] = [];
  ops.forEach((op, i) => {
    if (near[i]) out.push(op);
    else if (out[out.length - 1]?.kind !== "gap") out.push({ kind: "gap", text: "" });
  });
  return out;
}

export function parseFileTool(
  tool: FileToolName,
  input: unknown,
  output: unknown,
  hintChange?: "create" | "update",
): FileToolView {
  const out = objectOf(output);
  const pathField = field(input, "file_path", "path", "filePath");
  const path = pathField?.value ?? (typeof out?.filePath === "string" ? out.filePath : "");
  const { dir, base } = splitPath(path);
  const view: FileToolView = {
    tool,
    path,
    dir,
    base,
    language: languageFor(path),
    added: 0,
    removed: 0,
    clipped: false,
  };

  if (tool === "write") {
    const content = field(input, "content") ?? (typeof out?.content === "string" ? { value: out.content, clipped: false } : undefined);
    view.change = out?.type === "create" ? "create" : out?.type === "update" ? "update" : hintChange;
    view.clipped = content?.clipped ?? false;
    const patch = view.change === "update" ? patchToDiff(out?.structuredPatch) : undefined;
    if (patch) view.diff = patch;
    else if (content) view.code = toLines(content.value, 1);
  } else if (tool === "edit") {
    const patch = patchToDiff(out?.structuredPatch);
    if (patch) {
      view.diff = patch;
    } else {
      const before = field(input, "old_string");
      const after = field(input, "new_string");
      if (before || after) {
        view.diff = diffStrings(before?.value ?? "", after?.value ?? "");
        view.clipped = (before?.clipped ?? false) || (after?.clipped ?? false);
      }
    }
  } else if (typeof output === "string") {
    const offset = numberField(input, "offset") ?? 1;
    const envelope = unwrapReadEnvelope(output);
    if (envelope) {
      view.code = readLines(envelope.content, envelope.startLine ?? offset);
      view.clipped = envelope.clipped;
      if (envelope.partial) view.totalLines = envelope.totalLines;
    } else if (/^\s*\{"type"\s*:\s*"(?!text")/.test(output) && /"file"\s*:/.test(output.slice(0, 200))) {
      // image / pdf / file_unchanged envelope: nothing textual to draw.
    } else {
      view.code = readLines(output, offset);
      view.clipped = output.endsWith("…") && output.length > HARNESS_OUTPUT_CLIP;
    }
  }

  for (const line of view.diff ?? []) {
    if (line.kind === "add") view.added += 1;
    else if (line.kind === "del") view.removed += 1;
  }
  if (view.code && tool === "write") view.added = view.code.length;
  return view;
}
