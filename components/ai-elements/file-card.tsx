"use client";

import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  FilePenLineIcon,
  FilePlusIcon,
  FileTextIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { BundledLanguage } from "shiki";
import { highlightCode, TokenSpan } from "@/components/ai-elements/code-block";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { copyText } from "@/lib/clipboard";
import { parseFileTool, type DiffLine, type FileToolName, type FileToolView } from "@/lib/file-tool-view";
import { cn } from "@/lib/utils";

export type FileCardState = "running" | "completed" | "error";

/** Lines drawn before a "N more lines" note — keeps huge files cheap. */
const MAX_LINES = 300;
/** Content up to this many lines starts open; longer starts collapsed. */
const OPEN_LINES = 16;

type Tokens = NonNullable<ReturnType<typeof highlightCode>>["tokens"];

/** Syntax tokens per line: instant plain text first, shiki once it loads. */
function useHighlightedLines(lines: readonly string[], language: string): Tokens | null {
  const code = useMemo(() => lines.join("\n"), [lines]);
  const key = `${language}\u0000${code}`;
  const plain = language === "text";
  const cached = useMemo(
    () => (plain ? null : highlightCode(code, language as BundledLanguage)),
    [code, language, plain],
  );
  const [loaded, setLoaded] = useState<{ key: string; tokens: Tokens } | null>(null);
  useEffect(() => {
    if (plain) return;
    let cancelled = false;
    highlightCode(code, language as BundledLanguage, (result) => {
      if (!cancelled) setLoaded({ key, tokens: result.tokens });
    });
    return () => {
      cancelled = true;
    };
  }, [code, language, key, plain]);
  const tokens = (loaded?.key === key ? loaded.tokens : null) ?? cached?.tokens ?? null;
  return tokens && tokens.length === lines.length ? tokens : null;
}

function Gutter({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("w-10 shrink-0 select-none pr-2 text-right text-muted-foreground/60", className)}
    >
      {children}
    </span>
  );
}

function CodeRows({ rows, language }: { rows: { text: string; num?: number }[]; language: string }) {
  const lines = useMemo(() => rows.map((r) => r.text), [rows]);
  const tokens = useHighlightedLines(lines, language);
  return (
    <div className="min-w-fit py-1.5 font-mono text-[12px] leading-relaxed">
      {rows.map((row, i) => (
        <div key={i} className="flex px-0">
          <Gutter>{row.num}</Gutter>
          <span className="whitespace-pre pr-4">
            {tokens?.[i]?.length
              ? tokens[i]!.map((token, j) => <TokenSpan key={j} token={token} />)
              : row.text || " "}
          </span>
        </div>
      ))}
    </div>
  );
}

function DiffRows({ rows, language }: { rows: DiffLine[]; language: string }) {
  const real = useMemo(() => rows.filter((r) => r.kind !== "gap"), [rows]);
  const tokens = useHighlightedLines(useMemo(() => real.map((r) => r.text), [real]), language);
  let at = -1;
  return (
    <div className="min-w-fit py-1.5 font-mono text-[12px] leading-relaxed">
      {rows.map((row, i) => {
        if (row.kind === "gap") {
          return (
            <div key={i} className="flex select-none items-center py-0.5 text-muted-foreground/50">
              <Gutter>⋯</Gutter>
            </div>
          );
        }
        at += 1;
        const t = tokens?.[at];
        return (
          <div
            key={i}
            className={cn(
              "flex",
              row.kind === "add" && "bg-success/10",
              row.kind === "del" && "bg-destructive/10",
            )}
          >
            <Gutter className={cn(row.kind === "add" && "text-success", row.kind === "del" && "text-destructive")}>
              {row.num}
            </Gutter>
            <span
              aria-hidden
              className={cn(
                "w-4 shrink-0 select-none text-center",
                row.kind === "add" && "text-success",
                row.kind === "del" && "text-destructive",
              )}
            >
              {row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""}
            </span>
            <span className="whitespace-pre pr-4">
              {t?.length ? t.map((token, j) => <TokenSpan key={j} token={token} />) : row.text || " "}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const VERBS: Record<FileToolName, { running: string; done: string }> = {
  write: { running: "Writing", done: "Wrote" },
  edit: { running: "Editing", done: "Edited" },
  read: { running: "Reading", done: "Read" },
};

function verbFor(view: FileToolView, state: FileCardState): string {
  if (state === "error") return view.tool === "read" ? "Couldn't read" : view.tool === "edit" ? "Couldn't edit" : "Couldn't write";
  if (view.tool === "write" && state === "completed") {
    return view.change === "create" ? "Created" : view.change === "update" ? "Overwrote" : "Wrote";
  }
  return state === "running" ? VERBS[view.tool].running : VERBS[view.tool].done;
}

function Pill({ tone, label }: { tone: "running" | "ok" | "fail"; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] leading-none",
        tone === "running" && "border-info/30 bg-info/10 text-info",
        tone === "ok" && "border-success/30 bg-success/10 text-success",
        tone === "fail" && "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full bg-current", tone === "running" && "animate-pulse")} />
      {label}
    </span>
  );
}

/**
 * A harness file tool call (write / edit / read) as a document card: the
 * verb and path in the header with a +/− tally, and the content below —
 * syntax-highlighted with line numbers for write/read, a real line diff for
 * edit. Short content is shown open; long content folds behind the toggle.
 */
export function FileCard({
  tool,
  state,
  input,
  output,
  errorText,
  hintChange,
  className,
}: {
  tool: FileToolName;
  state: FileCardState;
  input: unknown;
  output?: unknown;
  errorText?: string;
  /** What a fileChange event said, when the tool's own output doesn't. */
  hintChange?: "create" | "update";
  className?: string;
}) {
  const view = useMemo(() => parseFileTool(tool, input, output, hintChange), [tool, input, output, hintChange]);
  const rows = view.diff ?? view.code ?? [];
  const failed = state === "error";
  const total = rows.filter((r) => ("kind" in r ? r.kind !== "gap" : true)).length;
  const shown = rows.slice(0, MAX_LINES);
  const hidden = rows.length - shown.length;
  const [open, setOpen] = useState(failed || (total > 0 && total <= OPEN_LINES));
  const [copied, setCopied] = useState(false);

  const Icon = tool === "read" ? FileTextIcon : tool === "edit" ? FilePenLineIcon : FilePlusIcon;
  const copyable = view.code ? view.code.map((l) => l.text).join("\n") : undefined;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "group not-prose w-full overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm",
        failed ? "border-destructive/40" : "border-border",
        className,
      )}
    >
      <div className="flex items-center gap-2.5 px-3 py-2">
        <Icon className={cn("size-4 shrink-0", failed ? "text-destructive" : "text-muted-foreground")} aria-hidden />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-xs text-muted-foreground">{verbFor(view, state)}</span>
          <span className="min-w-0 truncate font-mono text-[12.5px]" title={view.path}>
            <span className="text-muted-foreground">{view.dir}</span>
            <span className="font-medium text-foreground">{view.base || "…"}</span>
          </span>
        </div>
        {(view.added > 0 || view.removed > 0) && (
          <span className="flex shrink-0 gap-1.5 font-mono text-[11px]">
            {view.added > 0 && <span className="text-success">+{view.added}</span>}
            {view.removed > 0 && <span className="text-destructive">−{view.removed}</span>}
          </span>
        )}
        {tool === "read" && total > 0 && (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{total} lines</span>
        )}
        <Pill
          tone={failed ? "fail" : state === "running" ? "running" : "ok"}
          label={failed ? "failed" : state === "running" ? "running" : "done"}
        />
        {total > 0 && (
          <CollapsibleTrigger
            aria-label={open ? "Hide contents" : "Show contents"}
            className="-mr-1 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
        )}
      </div>

      {total > 0 && (
        <CollapsibleContent>
          <div className="group/body relative border-t border-border bg-muted/30">
            <div className="max-h-80 overflow-auto">
              {view.diff ? (
                <DiffRows rows={shown as DiffLine[]} language={view.language} />
              ) : (
                <CodeRows rows={shown as { text: string; num: number }[]} language={view.language} />
              )}
              {(hidden > 0 || view.clipped) && (
                <p className="border-t border-border px-3 py-1.5 font-mono text-[11px] italic text-muted-foreground">
                  {hidden > 0 ? `… ${hidden} more lines` : "… preview clipped"}
                </p>
              )}
            </div>
            {copyable && (
              <button
                type="button"
                aria-label="Copy contents"
                title="Copy contents"
                onClick={async () => {
                  if (await copyText(copyable)) {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }
                }}
                className="absolute right-2 top-1.5 rounded bg-card/80 p-1 text-muted-foreground opacity-0 backdrop-blur transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/body:opacity-100"
              >
                {copied ? <CheckIcon className="size-3.5 text-success" /> : <CopyIcon className="size-3.5" />}
              </button>
            )}
          </div>
        </CollapsibleContent>
      )}

      {failed && (
        <p className="border-t border-destructive/30 bg-destructive/10 px-3 py-2 font-mono text-[11px] text-destructive">
          {errorText ?? "tool failed"}
        </p>
      )}
    </Collapsible>
  );
}
