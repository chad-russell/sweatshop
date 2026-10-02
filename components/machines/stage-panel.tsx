"use client";

import { ArrowRight, Flag, Play, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_MAX_VISITS, END, HARNESSES, type MachineDefinition, type Stage } from "@/lib/machines/definition";
import type { StageKind, StagePatch } from "@/lib/machines/edit";
import { CHAT_MODELS } from "@/lib/model";

/**
 * 0014: the editor's side panel — the form for whichever stage or
 * transition is selected. Every change is reported as an edit operation
 * (the shell applies it to the draft); the panel never holds the
 * definition itself, only in-progress text for the id field.
 */

const DEFAULT = "__default__";
const THINKING = ["off", "low", "medium", "high"] as const;

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  );
}

export function StagePanel({
  definition,
  id,
  issues,
  onPatch,
  onKind,
  onRename,
  onStart,
  onRemove,
  onSelectEdge,
}: {
  definition: MachineDefinition;
  id: string;
  issues: readonly string[];
  onPatch: (patch: StagePatch) => void;
  onKind: (kind: StageKind) => void;
  /** Returns an error message when the rename is refused. */
  onRename: (to: string) => string | null;
  onStart: () => void;
  onRemove: () => void;
  onSelectEdge: (target: string) => void;
}) {
  const stage: Stage = definition.stages[id]!;
  const [idText, setIdText] = useState(id);
  const [idError, setIdError] = useState<string | null>(null);
  const commitId = () => {
    const to = idText.trim();
    if (!to || to === id) {
      setIdText(id);
      setIdError(null);
      return;
    }
    const err = onRename(to);
    setIdError(err);
    if (err) setIdText(id);
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{stage.title || id}</h2>
        {definition.start === id ? (
          <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
            <Play className="size-3" aria-hidden /> start
          </span>
        ) : (
          <Button size="xs" variant="ghost" onClick={onStart}>
            <Play /> Set start
          </Button>
        )}
        <Button size="icon-xs" variant="ghost" aria-label="Delete stage" className="text-destructive" onClick={onRemove}>
          <Trash2 />
        </Button>
      </header>

      {issues.length > 0 && (
        <ul role="alert" className="flex flex-col gap-0.5 rounded-md border border-destructive/50 p-2 font-mono text-[11px] text-destructive">
          {issues.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}

      <Field label="Title">
        <Input value={stage.title} onChange={(e) => onPatch({ title: e.target.value })} maxLength={80} />
      </Field>

      <Field label="Id" hint={idError ?? "Lowercase kebab-case. Renaming updates every transition into it."}>
        <Input
          value={idText}
          onChange={(e) => setIdText(e.target.value)}
          onBlur={commitId}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitId();
            if (e.key === "Escape") {
              setIdText(id);
              setIdError(null);
            }
          }}
          aria-invalid={Boolean(idError)}
          className="font-mono"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Kind">
          <Select value={stage.kind} onValueChange={(v) => onKind(v as StageKind)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="agent">agent</SelectItem>
              <SelectItem value="harness">harness</SelectItem>
              <SelectItem value="human">human</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Max visits">
          <Input
            type="number"
            min={1}
            max={20}
            placeholder={String(DEFAULT_MAX_VISITS)}
            value={stage.maxVisits ?? ""}
            onChange={(e) => onPatch({ maxVisits: e.target.value ? Number(e.target.value) : undefined })}
          />
        </Field>
      </div>

      {stage.kind === "harness" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Harness">
            <Select value={stage.harness} onValueChange={(v) => onPatch({ harness: v as (typeof HARNESSES)[number] })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HARNESSES.map((h) => (
                  <SelectItem key={h} value={h}>
                    {h}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Thinking">
            <Select value={stage.thinking ?? DEFAULT} onValueChange={(v) => onPatch({ thinking: v === DEFAULT ? undefined : (v as (typeof THINKING)[number]) })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT}>default</SelectItem>
                {THINKING.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="col-span-2">
            <Field label="Model" hint={stage.harness === "pi" ? "provider/model; empty = the harness default" : "Claude model; empty = default"}>
              <Input
                value={stage.model ?? ""}
                onChange={(e) => onPatch({ model: e.target.value || undefined })}
                className="font-mono"
                placeholder="default"
              />
            </Field>
          </div>
        </div>
      )}

      {stage.kind === "agent" && (
        <Field label="Model">
          <Select value={stage.model ?? DEFAULT} onValueChange={(v) => onPatch({ model: v === DEFAULT ? undefined : v })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT}>default</SelectItem>
              {CHAT_MODELS.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      <Field label={stage.kind === "human" ? "Instructions (shown at the gate)" : "Instructions"}>
        <Textarea
          value={stage.instructions}
          onChange={(e) => onPatch({ instructions: e.target.value })}
          className="min-h-48 text-sm"
          spellCheck
        />
      </Field>

      <section className="flex flex-col gap-1.5">
        <h3 className="text-xs text-muted-foreground">Transitions</h3>
        {stage.next.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            None — the run ends after this stage. Drag from its right handle to connect.
          </p>
        ) : (
          stage.next.map((t) => (
            <button
              key={t.to}
              type="button"
              onClick={() => onSelectEdge(t.to)}
              className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-left text-xs hover:bg-accent"
            >
              <ArrowRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />
              {t.to === END ? <Flag className="size-3 text-muted-foreground" aria-label="end" /> : null}
              <span className="font-mono">{t.to}</span>
              {t.when && <span className="truncate text-muted-foreground">— {t.when}</span>}
            </button>
          ))
        )}
        {stage.next.length > 1 && (
          <p className="text-[11px] text-muted-foreground">
            {stage.kind === "human"
              ? "Each transition is a button at the gate, labeled by its “when”."
              : "The agent picks one with its transition tool, guided by each “when”."}
          </p>
        )}
      </section>
    </div>
  );
}

export function TransitionPanel({
  definition,
  source,
  target,
  issues,
  onWhen,
  onRemove,
  onSelectStage,
}: {
  definition: MachineDefinition;
  source: string;
  target: string;
  issues: readonly string[];
  onWhen: (when: string) => void;
  onRemove: () => void;
  onSelectStage: (id: string) => void;
}) {
  const transition = definition.stages[source]?.next.find((t) => t.to === target);
  if (!transition) return null;
  const branching = (definition.stages[source]?.next.length ?? 0) > 1;
  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center gap-2 font-mono text-sm">
        <button type="button" className="hover:underline" onClick={() => onSelectStage(source)}>
          {source}
        </button>
        <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden />
        {target === END ? (
          <span>end</span>
        ) : (
          <button type="button" className="hover:underline" onClick={() => onSelectStage(target)}>
            {target}
          </button>
        )}
        <Button size="icon-xs" variant="ghost" aria-label="Delete transition" className="ml-auto text-destructive" onClick={onRemove}>
          <Trash2 />
        </Button>
      </header>
      {issues.length > 0 && (
        <ul role="alert" className="flex flex-col gap-0.5 rounded-md border border-destructive/50 p-2 font-mono text-[11px] text-destructive">
          {issues.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
      <Field
        label="When"
        hint={
          branching
            ? "Shown to the agent (or on the gate button) to choose this branch."
            : "Optional — a single transition is taken automatically."
        }
      >
        <Input value={transition.when ?? ""} onChange={(e) => onWhen(e.target.value)} maxLength={400} />
      </Field>
    </div>
  );
}
