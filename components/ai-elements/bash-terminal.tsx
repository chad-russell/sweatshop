"use client";

import { CheckIcon, ChevronDownIcon, CopyIcon, SquareTerminalIcon } from "lucide-react";
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { luminance, parseAnsi, stripAnsi, type AnsiColor, type AnsiSegment, type NamedColor } from "@/lib/ansi";
import { parseBash, splitCd } from "@/lib/bash-view";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

/** Mirrors the AI SDK tool part states the rest of the transcript uses. */
export type BashState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error"
  | "output-denied"
  | "approval-requested"
  | "approval-responded";

// Full class strings (not templated) so Tailwind can see them.
const FG_CLASS: Record<NamedColor, string> = {
  black: "text-terminal-black",
  red: "text-terminal-red",
  green: "text-terminal-green",
  yellow: "text-terminal-yellow",
  blue: "text-terminal-blue",
  magenta: "text-terminal-magenta",
  cyan: "text-terminal-cyan",
  white: "text-terminal-white",
  foreground: "text-terminal-foreground",
  background: "text-terminal",
};

const BG_CLASS: Record<NamedColor, string> = {
  black: "bg-terminal-bg-black",
  red: "bg-terminal-bg-red",
  green: "bg-terminal-bg-green",
  yellow: "bg-terminal-bg-yellow",
  blue: "bg-terminal-bg-blue",
  magenta: "bg-terminal-bg-magenta",
  cyan: "bg-terminal-bg-cyan",
  white: "bg-terminal-bg-white",
  foreground: "bg-terminal-foreground",
  background: "bg-terminal",
};

const isLiteral = (c: AnsiColor): c is `#${string}` => c.startsWith("#");

/** Text colour for a segment: explicit fg wins; on a coloured background,
 *  black/default text becomes the dark "ink" (or light, on a dark block). */
function fgFor(s: AnsiSegment): { className?: string; style?: CSSProperties } {
  const { fg, bg } = s;
  if (bg) {
    const darkBlock = isLiteral(bg) ? luminance(bg) < 0.35 : bg === "black";
    if (!fg || fg === "black" || fg === "foreground") {
      // Inverse of the default (bg=foreground, fg=background) is handled below.
      if (bg === "foreground") return { className: "text-terminal" };
      return { className: darkBlock ? "text-terminal-bg-white" : "text-terminal-ink" };
    }
  }
  if (!fg) return {};
  return isLiteral(fg) ? { style: { color: fg } } : { className: FG_CLASS[fg] };
}

function Segments({ segments, base }: { segments: AnsiSegment[]; base?: string }) {
  return (
    <>
      {segments.map((s, i) => {
        const fg = fgFor(s);
        const bgStyle = s.bg && isLiteral(s.bg) ? { backgroundColor: s.bg } : undefined;
        return (
          <span
            key={i}
            style={{ ...fg.style, ...bgStyle }}
            className={cn(
              base,
              fg.className,
              s.bg && !isLiteral(s.bg) && BG_CLASS[s.bg],
              s.bg && "rounded-[2px]",
              s.bold && "font-semibold",
              s.dim && "opacity-60",
              s.italic && "italic",
              s.underline && "underline underline-offset-2",
              s.strike && "line-through",
            )}
          >
            {s.text}
          </span>
        );
      })}
    </>
  );
}

function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={async (e) => {
        e.stopPropagation();
        if (await copyText(text)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }
      }}
      className={cn(
        "rounded p-1 text-terminal-muted transition-colors hover:bg-terminal-foreground/10 hover:text-terminal-foreground",
        className,
      )}
    >
      {copied ? <CheckIcon className="size-3.5 text-terminal-green" /> : <CopyIcon className="size-3.5" />}
    </button>
  );
}

/** Output up to this many lines is shown without a click. */
const SHOW_INLINE_LINES = 12;

type Tone = "running" | "ok" | "fail";

function StatusPill({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] leading-none",
        tone === "running" && "border-terminal-yellow/30 bg-terminal-yellow/10 text-terminal-yellow",
        tone === "ok" && "border-terminal-green/30 bg-terminal-green/10 text-terminal-green",
        tone === "fail" && "border-terminal-red/30 bg-terminal-red/10 text-terminal-red",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full bg-current",
          tone === "running" && "animate-pulse",
        )}
      />
      {label}
    </span>
  );
}

/**
 * A bash tool call drawn as a terminal session: a window bar (icon, name,
 * exit-code pill), the command as typed at a `$` prompt, and the output
 * below it — stderr in red, ANSI colours honoured. Output collapses to a
 * one-line summary; the command is always visible.
 */
export function BashTerminal({
  state,
  input,
  output,
  errorText,
  extra,
  className,
}: {
  state: BashState;
  input: unknown;
  output?: unknown;
  errorText?: string;
  /** Extra header content (e.g. the sandbox chip). */
  extra?: ReactNode;
  className?: string;
}) {
  const view = useMemo(() => parseBash(input, output, errorText), [input, output, errorText]);
  const running = state === "input-available" || state === "input-streaming" || state === "approval-responded";
  const awaiting = state === "approval-requested";
  const errored = state === "output-error" || state === "output-denied";
  const failed = errored || (view.exitCode !== undefined && view.exitCode !== 0);

  const tone: Tone = failed ? "fail" : running || awaiting ? "running" : "ok";
  const label = state === "output-denied"
    ? "denied"
    : awaiting
      ? "awaiting approval"
      : running
        ? "running"
        : errored
          ? "error"
          : view.exitCode !== undefined
            ? `exit ${view.exitCode}`
            : "done";

  const stdoutLines = useMemo(() => (view.stdout.trim() ? parseAnsi(view.stdout.replace(/\n+$/, "")) : []), [view.stdout]);
  const stderrLines = useMemo(() => (view.stderr.trim() ? parseAnsi(view.stderr.replace(/\n+$/, "")) : []), [view.stderr]);
  const lineCount = stdoutLines.length + stderrLines.length;
  const hasBody = lineCount > 0;

  const { cwd, rest } = useMemo(() => splitCd(view.command), [view.command]);
  const commandLines = rest.split("\n");
  const plainOutput = [stripAnsi(view.stdout).trimEnd(), stripAnsi(view.stderr).trimEnd()].filter(Boolean).join("\n");

  // Short output reads like a real terminal — shown inline. Long output
  // starts collapsed (the line count in the bar expands it) unless the
  // command failed, when the output is what you came for.
  const [open, setOpen] = useState(hasBody && (failed || lineCount <= SHOW_INLINE_LINES));

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "group not-prose w-full overflow-hidden rounded-lg border bg-terminal text-terminal-foreground shadow-sm",
        failed ? "border-terminal-red/40" : "border-terminal-border",
        className,
      )}
    >
      {/* Window bar */}
      <div className="flex items-center gap-2 border-b border-terminal-border px-3 py-1.5">
        <SquareTerminalIcon className="size-4 shrink-0 text-terminal-muted" aria-hidden />
        <span className="font-mono text-xs text-terminal-muted">bash</span>
        <StatusPill tone={tone} label={label} />
        <span className="ml-auto flex items-center gap-1">
          {extra}
          {hasBody && (
            <CollapsibleTrigger
              aria-label={open ? "Hide output" : "Show output"}
              className="flex items-center gap-1 rounded p-1 font-mono text-[10px] text-terminal-muted transition-colors hover:bg-terminal-foreground/10 hover:text-terminal-foreground"
            >
              {lineCount} {lineCount === 1 ? "line" : "lines"}
              <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
          )}
        </span>
      </div>

      {/* Command, as typed */}
      <div className="group/cmd relative flex gap-2 px-3 py-2 font-mono text-[12.5px] leading-relaxed">
        {cwd && (
          <span className="shrink-0 select-none text-terminal-muted" title={`cd ${cwd}`}>
            {cwd}
          </span>
        )}
        <span aria-hidden className="select-none text-terminal-green">
          $
        </span>
        <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-words">
          {commandLines.map((line, i) => (
            <span key={i} className="block">
              {line || " "}
              {running && i === commandLines.length - 1 && (
                <span aria-hidden className="ml-0.5 inline-block h-[1.1em] w-[0.5ch] translate-y-[0.2em] animate-pulse bg-terminal-foreground/80" />
              )}
            </span>
          ))}
        </pre>
        {view.command && (
          <CopyButton
            text={view.command}
            label="Copy command"
            className="absolute right-2 top-1.5 opacity-0 focus-visible:opacity-100 group-hover/cmd:opacity-100"
          />
        )}
      </div>

      {/* Output */}
      {hasBody ? (
        <CollapsibleContent>
          <div className="group/out relative border-t border-terminal-border">
            <pre className="max-h-80 overflow-auto px-3 py-2 pl-[calc(0.75rem+1ch+0.5rem)] font-mono text-[12px] leading-relaxed">
              {stdoutLines.map((segments, i) => (
                <span key={`o${i}`} className="block whitespace-pre-wrap break-words">
                  {segments.length ? <Segments segments={segments} /> : " "}
                </span>
              ))}
              {stderrLines.map((segments, i) => (
                <span key={`e${i}`} className="block whitespace-pre-wrap break-words">
                  {segments.length ? <Segments segments={segments} base="text-terminal-red" /> : " "}
                </span>
              ))}
            </pre>
            <CopyButton
              text={plainOutput}
              label="Copy output"
              className="absolute right-2 top-1.5 opacity-0 focus-visible:opacity-100 group-hover/out:opacity-100"
            />
          </div>
        </CollapsibleContent>
      ) : view.hasOutput && !running ? (
        <p className="border-t border-terminal-border px-3 py-1.5 font-mono text-[11px] italic text-terminal-muted">
          no output
        </p>
      ) : null}
    </Collapsible>
  );
}
