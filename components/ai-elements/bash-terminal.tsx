"use client";

import { CheckIcon, ChevronDownIcon, CopyIcon, SquareTerminalIcon } from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { luminance, parseAnsi, stripAnsi, type AnsiColor, type AnsiSegment, type NamedColor } from "@/lib/ansi";
import { bashStatusPill, parseBash, splitCd } from "@/lib/tool-views/bash";
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
 * A bash tool call drawn as a terminal session. Collapsed it is one
 * header row like the other agent cards — icon, the caller's description
 * (else the command's first line), the extra chip (host / target sandbox), a
 * status pill only while running or on trouble (success is quiet), a chevron. Open, it shows the
 * command as typed at a `$` prompt and the output below it — stderr in
 * red, ANSI colours honoured.
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
  /** Extra header content (e.g. the exec host chip). */
  extra?: ReactNode;
  className?: string;
}) {
  const view = useMemo(() => parseBash(input, output, errorText), [input, output, errorText]);
  const running = state === "input-available" || state === "input-streaming" || state === "approval-responded";
  const awaiting = state === "approval-requested";
  const errored = state === "output-error" || state === "output-denied";
  const failed = errored || (view.exitCode !== undefined && view.exitCode !== 0);

  const pill = bashStatusPill(state, view.exitCode);

  const stdoutLines = useMemo(() => (view.stdout.trim() ? parseAnsi(view.stdout.replace(/\n+$/, "")) : []), [view.stdout]);
  const stderrLines = useMemo(() => (view.stderr.trim() ? parseAnsi(view.stderr.replace(/\n+$/, "")) : []), [view.stderr]);
  const lineCount = stdoutLines.length + stderrLines.length;
  const hasBody = lineCount > 0;

  const { cwd, rest } = useMemo(() => splitCd(view.command), [view.command]);
  const commandLines = rest.split("\n");
  const plainOutput = [stripAnsi(view.stdout).trimEnd(), stripAnsi(view.stderr).trimEnd()].filter(Boolean).join("\n");

  // Collapsed is the header alone (the Fetch card's shape): what the call
  // was for, where it ran, how it ended. The command and output open on a
  // click — or by themselves when Chad must read them: a failure, or a
  // command awaiting his approval.
  const [open, setOpen] = useState(failed || awaiting);
  // A live call that ends in failure opens itself (it mounted closed).
  useEffect(() => {
    if (failed || awaiting) setOpen(true);
  }, [failed, awaiting]);
  const headline = view.description ?? (rest.split("\n").find((l) => l.trim()) ?? "").trim();

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
      {/* Header — the whole bar toggles; links/buttons inside keep their own clicks. */}
      <div
        className="flex cursor-pointer items-center gap-2.5 px-3 py-2"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a,button")) return;
          setOpen((o) => !o);
        }}
      >
        <SquareTerminalIcon className={cn("size-4 shrink-0", failed ? "text-terminal-red" : "text-terminal-muted")} aria-hidden />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 font-mono text-xs text-terminal-muted">bash</span>
          {headline && (
            <span
              className={cn("min-w-0 truncate text-[12.5px] font-medium", !view.description && "font-mono")}
              title={view.description ? `${view.description}\n\n$ ${view.command}` : view.command}
            >
              {headline}
            </span>
          )}
        </div>
        {extra}
        {pill && <StatusPill tone={pill.tone} label={pill.label} />}
        <CollapsibleTrigger
          aria-label={open ? "Hide command and output" : "Show command and output"}
          className="-mr-1 rounded p-1 text-terminal-muted transition-colors hover:bg-terminal-foreground/10 hover:text-terminal-foreground"
        >
          <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
      </div>

      <CollapsibleContent className="border-t border-terminal-border">
        {/* Command, as typed */}
        {/* Narrow screens stack the cwd above the prompt line so a long path
            can't squeeze the command into a sliver; sm+ keeps one row. */}
        <div className="group/cmd relative flex flex-col px-3 py-2 font-mono text-[12.5px] leading-relaxed sm:flex-row sm:gap-2">
          {cwd && (
            <span
              className="min-w-0 select-none break-all pr-6 text-terminal-muted sm:max-w-[50%] sm:shrink-0 sm:pr-0"
              title={`cd ${cwd}`}
            >
              {cwd}
            </span>
          )}
          <div className="flex min-w-0 flex-1 gap-2">
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
          </div>
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
            {!running && (
              <p className="border-t border-terminal-border px-3 py-1 font-mono text-[10px] text-terminal-muted">
                {lineCount} {lineCount === 1 ? "line" : "lines"}
                {view.exitCode !== undefined && ` · exit ${view.exitCode}`}
              </p>
            )}
          </div>
        ) : view.hasOutput && !running ? (
          <p className="border-t border-terminal-border px-3 py-1.5 font-mono text-[11px] italic text-terminal-muted">
            no output
          </p>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}
