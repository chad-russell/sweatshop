"use client";

import { ArrowDown, ArrowUp, Check, CheckCircle2 } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import type { BundledLanguage } from "shiki";
import { MessageResponse } from "@/components/ai-elements/message";
import { CodeBlockContainer, CodeBlockContent } from "@/components/ai-elements/code-block";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  formatStructuredAnswers,
  type AskOwnerCard,
  type QuestionAnswer,
  type QuestionEvidence,
  type QuestionOption,
  type StructuredQuestion,
} from "@/lib/question-form";

/**
 * 0081: the ONE structured ask_owner form, shared by the transcript's
 * AskOwnerCard (components/chat-cards/approvals.tsx) and the Inbox's
 * QuestionCard (components/inbox/question-card.tsx). Renders a resolved
 * `AskOwnerCard` (screenshot evidence already an attachment id/url) and
 * calls `onSubmit` with one answer per question. Knows nothing about
 * `/api/x/input` — the host component POSTs.
 */

/** Per-question local draft: which alternative is active. Rank's default
 *  seeds the given option order so the ranked list is never empty. */
type Mode =
  | { kind: "options"; ids: string[] }
  | { kind: "other"; text: string }
  | { kind: "youPick" };

function initialModes(questions: readonly StructuredQuestion[]): Record<string, Mode> {
  const init: Record<string, Mode> = {};
  for (const q of questions) {
    if (q.type === "rank" && q.options && q.options.length > 0) {
      init[q.id] = { kind: "options", ids: q.options.map((o) => o.id) };
    }
  }
  return init;
}

function modeToAnswer(q: StructuredQuestion, mode: Mode | undefined): QuestionAnswer | null {
  if (!mode) return null;
  if (mode.kind === "youPick") return { youPick: true };
  if (mode.kind === "other") return mode.text.trim() ? { other: mode.text.trim() } : null;
  if (q.type === "text") return null;
  return mode.ids.length > 0 ? { selected: mode.ids } : null;
}

function EvidenceView({ evidence }: { evidence: QuestionEvidence }) {
  if (evidence.type === "code") {
    return (
      <CodeBlockContainer language={evidence.lang ?? "text"} className="mt-2">
        <CodeBlockContent code={evidence.text} language={(evidence.lang as BundledLanguage) ?? "text"} />
      </CodeBlockContainer>
    );
  }
  if (evidence.type === "diff") {
    return (
      <pre className="mt-2 max-h-64 overflow-auto rounded-md border bg-background p-2 font-mono text-xs whitespace-pre-wrap">
        {evidence.text.split("\n").map((line, i) => (
          <span
            key={i}
            className={cn(
              "block",
              line.startsWith("+") && !line.startsWith("+++") && "bg-success/10 text-success",
              line.startsWith("-") && !line.startsWith("---") && "bg-destructive/10 text-destructive",
            )}
          >
            {line}
          </span>
        ))}
      </pre>
    );
  }
  if (evidence.type === "markdown") {
    return (
      <div className="mt-2 text-sm">
        <MessageResponse>{evidence.text}</MessageResponse>
      </div>
    );
  }
  if (evidence.type === "link") {
    return (
      <a href={evidence.url} target="_blank" rel="noreferrer" className="mt-2 block text-sm text-info underline">
        {evidence.label ?? evidence.url}
      </a>
    );
  }
  // screenshot
  if ("unavailable" in evidence) {
    return <p className="mt-2 text-xs text-muted-foreground">[screenshot unavailable]</p>;
  }
  return (
    <a
      href={evidence.url}
      target="_blank"
      rel="noreferrer"
      className="mt-2 block overflow-hidden rounded-md border border-border"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- immutable attachment files served by our API */}
      <img src={evidence.url} alt="attached screenshot" className="max-h-48 w-full object-cover object-top" />
    </a>
  );
}

function OptionEvidence({ evidence }: { evidence: QuestionEvidence }) {
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
        Show evidence
      </summary>
      <EvidenceView evidence={evidence} />
    </details>
  );
}

function OptionRow({
  option,
  index,
  checked,
  control,
  onClick,
  disabled,
}: {
  option: QuestionOption;
  index: number;
  checked: boolean;
  control: "radio" | "checkbox";
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-md border px-2.5 py-2 transition-colors pointer-coarse:px-3 pointer-coarse:py-2.5",
        checked ? "border-ring bg-accent" : "border-border hover:bg-accent/50",
      )}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className="flex w-full items-start gap-2 text-left disabled:opacity-50"
        role={control === "radio" ? "radio" : "checkbox"}
        aria-checked={checked}
      >
        {control === "checkbox" ? (
          <Checkbox checked={checked} className="mt-0.5" tabIndex={-1} />
        ) : (
          <span
            className={cn(
              "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
              checked ? "border-primary bg-primary" : "border-input",
            )}
            aria-hidden
          >
            {checked && <span className="size-1.5 rounded-full bg-primary-foreground" />}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[10px] text-muted-foreground">{index + 1}</span>
            <span className="text-sm">{option.label}</span>
            {option.recommended && (
              <Badge variant="outline" className="text-[10px] text-info">
                recommended
              </Badge>
            )}
          </span>
          {option.description && (
            <span className="mt-0.5 block text-xs text-muted-foreground">{option.description}</span>
          )}
        </span>
      </button>
      {option.evidence && <OptionEvidence evidence={option.evidence} />}
    </div>
  );
}

function RankRow({
  option,
  index,
  total,
  onMove,
  disabled,
}: {
  option: QuestionOption;
  index: number;
  total: number;
  onMove: (by: -1 | 1) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border px-2.5 py-2 pointer-coarse:px-3 pointer-coarse:py-2.5">
      <span className="mt-0.5 font-mono text-[10px] text-muted-foreground">{index + 1}</span>
      <span className="min-w-0 flex-1">
        <span className="text-sm">{option.label}</span>
        {option.description && <span className="mt-0.5 block text-xs text-muted-foreground">{option.description}</span>}
        {option.evidence && <OptionEvidence evidence={option.evidence} />}
      </span>
      <div className="flex shrink-0 flex-col">
        <button
          type="button"
          aria-label={`Move "${option.label}" up`}
          disabled={disabled || index === 0}
          onClick={() => onMove(-1)}
          className="text-muted-foreground hover:text-foreground disabled:opacity-30"
        >
          <ArrowUp className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label={`Move "${option.label}" down`}
          disabled={disabled || index === total - 1}
          onClick={() => onMove(1)}
          className="text-muted-foreground hover:text-foreground disabled:opacity-30"
        >
          <ArrowDown className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/** "Other…"/"You pick" are runtime-supplied alternatives to every
 *  choice-type question (0081 decision 2) — never part of the model's
 *  own option list. */
function AlternativeRows({
  question,
  mode,
  onChange,
  disabled,
}: {
  question: StructuredQuestion;
  mode: Mode | undefined;
  onChange: (mode: Mode) => void;
  disabled: boolean;
}) {
  const isOther = mode?.kind === "other";
  const isYouPick = mode?.kind === "youPick";
  return (
    <div className="flex flex-col gap-1.5">
      {question.allowOther && (
        <div className={cn("rounded-md border px-2.5 py-2 pointer-coarse:px-3", isOther ? "border-ring bg-accent" : "border-border hover:bg-accent/50")}>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange({ kind: "other", text: isOther ? mode.text : "" })}
            className="flex w-full items-center gap-2 text-left text-sm disabled:opacity-50"
            aria-pressed={isOther}
          >
            Other…
          </button>
          {isOther && (
            <textarea
              value={mode.text}
              onChange={(e) => onChange({ kind: "other", text: e.target.value })}
              disabled={disabled}
              placeholder="Your own answer…"
              rows={2}
              className="mt-1.5 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            />
          )}
        </div>
      )}
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange({ kind: "youPick" })}
        aria-pressed={isYouPick}
        className={cn(
          "flex items-center gap-2 rounded-md border px-2.5 py-2 text-left text-sm disabled:opacity-50 pointer-coarse:px-3",
          isYouPick ? "border-ring bg-accent" : "border-border hover:bg-accent/50",
        )}
      >
        {isYouPick ? <CheckCircle2 className="size-3.5 text-info" aria-hidden /> : <span className="size-3.5" aria-hidden />}
        You pick — use your recommendation
      </button>
    </div>
  );
}

function QuestionPanel({
  question,
  mode,
  onChange,
  disabled,
  onFocus,
}: {
  question: StructuredQuestion;
  mode: Mode | undefined;
  onChange: (mode: Mode) => void;
  disabled: boolean;
  onFocus: () => void;
}) {
  const options = question.options ?? [];
  const selectedIds = mode?.kind === "options" ? mode.ids : [];
  const inAlternative = mode?.kind === "other" || mode?.kind === "youPick";

  const selectOption = (id: string) => {
    onFocus();
    if (question.type === "single") {
      onChange({ kind: "options", ids: [id] });
      return;
    }
    if (question.type === "multi") {
      const next = selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id];
      onChange({ kind: "options", ids: next });
    }
  };

  const moveRank = (index: number, by: -1 | 1) => {
    onFocus();
    const ids = mode?.kind === "options" ? mode.ids : options.map((o) => o.id);
    const target = index + by;
    if (target < 0 || target >= ids.length) return;
    const next = [...ids];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange({ kind: "options", ids: next });
  };

  return (
    <div className="flex flex-col gap-1.5" onFocus={onFocus} onClick={onFocus}>
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{question.header}</p>
      {question.type === "single" &&
        options.map((option, i) => (
          <OptionRow
            key={option.id}
            option={option}
            index={i}
            control="radio"
            checked={!inAlternative && selectedIds.includes(option.id)}
            onClick={() => selectOption(option.id)}
            disabled={disabled}
          />
        ))}
      {question.type === "multi" &&
        options.map((option, i) => (
          <OptionRow
            key={option.id}
            option={option}
            index={i}
            control="checkbox"
            checked={!inAlternative && selectedIds.includes(option.id)}
            onClick={() => selectOption(option.id)}
            disabled={disabled}
          />
        ))}
      {question.type === "rank" &&
        (() => {
          const ids = mode?.kind === "options" ? mode.ids : options.map((o) => o.id);
          const byId = new Map(options.map((o) => [o.id, o] as const));
          return (
            <div className={cn("flex flex-col gap-1.5", inAlternative && "pointer-events-none opacity-50")}>
              {ids.map((id, i) => {
                const option = byId.get(id);
                if (!option) return null;
                return (
                  <RankRow
                    key={id}
                    option={option}
                    index={i}
                    total={ids.length}
                    onMove={(by) => moveRank(i, by)}
                    disabled={disabled || inAlternative}
                  />
                );
              })}
            </div>
          );
        })()}
      {question.type === "text" && (
        <textarea
          value={mode?.kind === "other" ? mode.text : ""}
          onChange={(e) => onChange({ kind: "other", text: e.target.value })}
          onFocus={onFocus}
          disabled={disabled || mode?.kind === "youPick"}
          placeholder="Your answer…"
          rows={3}
          className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm disabled:opacity-50"
        />
      )}
      {question.type !== "text" && <AlternativeRows question={question} mode={mode} onChange={onChange} disabled={disabled} />}
      {question.type === "text" && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(mode?.kind === "youPick" ? { kind: "other", text: "" } : { kind: "youPick" })}
          aria-pressed={mode?.kind === "youPick"}
          className={cn(
            "flex w-fit items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm disabled:opacity-50",
            mode?.kind === "youPick" ? "border-ring bg-accent" : "border-border hover:bg-accent/50",
          )}
        >
          {mode?.kind === "youPick" ? <CheckCircle2 className="size-3.5 text-info" aria-hidden /> : <span className="size-3.5" aria-hidden />}
          You pick — use your recommendation
        </button>
      )}
    </div>
  );
}

/** A compact, read-only summary of an already-answered structured ask —
 *  the model-facing text, minus the trailing JSON block. */
export function questionFormSummary(card: AskOwnerCard, answers: Record<string, QuestionAnswer>): string {
  if (!card.questions || card.questions.length === 0) return "";
  const full = formatStructuredAnswers(card.questions, answers, "");
  return full.split("\n\n")[0]!.replace(/^\s*answered —\s*/, "").replace(/^\s*answered:\n/, "");
}

export function QuestionForm({
  card,
  busy,
  onSubmit,
}: {
  card: AskOwnerCard;
  busy: boolean;
  onSubmit: (answers: Record<string, QuestionAnswer>) => void;
}) {
  const questions = card.questions ?? [];
  const [modes, setModes] = useState<Record<string, Mode>>(() => initialModes(questions));
  const [focused, setFocused] = useState(0);

  const answers = questions.map((q) => modeToAnswer(q, modes[q.id]));
  const allAnswered = answers.every((a) => a !== null);

  const submit = () => {
    if (!allAnswered) return;
    const out: Record<string, QuestionAnswer> = {};
    questions.forEach((q, i) => {
      out[q.id] = answers[i]!;
    });
    onSubmit(out);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const typing = target.tagName === "TEXTAREA" || target.tagName === "INPUT";
    if (e.key === "Enter" && !typing && allAnswered) {
      e.preventDefault();
      submit();
      return;
    }
    if (typing) return;
    const n = Number(e.key);
    if (!Number.isInteger(n) || n < 1 || n > 9) return;
    const question = questions[focused];
    const options = question?.options;
    if (!question || !options || n > options.length) return;
    if (question.type !== "single" && question.type !== "multi") return;
    e.preventDefault();
    const id = options[n - 1]!.id;
    setModes((m) => {
      if (question.type === "single") {
        setFocused((f) => Math.min(f + 1, questions.length - 1));
        return { ...m, [question.id]: { kind: "options", ids: [id] } };
      }
      const current = m[question.id];
      const ids = current?.kind === "options" ? current.ids : [];
      const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
      return { ...m, [question.id]: { kind: "options", ids: next } };
    });
  };

  return (
    <div className="flex flex-col gap-3" onKeyDown={onKeyDown}>
      {card.context && (
        <details className="rounded-md border border-border bg-background px-2.5 py-1.5">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            Why I&apos;m asking
          </summary>
          <div className="mt-1.5 text-sm">
            <MessageResponse>{card.context}</MessageResponse>
          </div>
        </details>
      )}
      {questions.map((q, i) => (
        <QuestionPanel
          key={q.id}
          question={q}
          mode={modes[q.id]}
          onChange={(mode) => setModes((m) => ({ ...m, [q.id]: mode }))}
          disabled={busy}
          onFocus={() => setFocused(i)}
        />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || !allAnswered}
          onClick={submit}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50 pointer-coarse:px-4 pointer-coarse:py-2.5 pointer-coarse:text-sm"
        >
          <Check className="size-3.5" aria-hidden />
          Submit
        </button>
        {!allAnswered && (
          <span className="text-xs text-muted-foreground">Answer every question to submit</span>
        )}
      </div>
    </div>
  );
}
