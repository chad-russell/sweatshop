"use client";

import { RoutePicker } from "@/components/route-picker";
import type { ModelsView } from "@/lib/providers/catalog-view";
import {
  CLAUDE_EFFORTS,
  THINKING_LEVELS,
  type ChatRoute,
  type HarnessRoute,
} from "@/lib/providers/route";

const SELECT = "h-8 rounded-lg border border-border bg-background px-2 text-xs text-foreground disabled:opacity-50";

/** Compact editor for an outline step runner, reusing the shared model
 * catalog and RoutePicker rather than maintaining another model list. */
export function HarnessRoutePicker({ value, view, onChange }: {
  value: "auto" | "self" | "thread" | HarnessRoute | undefined;
  view: ModelsView | null;
  onChange: (runner: "auto" | "self" | "thread" | HarnessRoute) => void;
}) {
  const kind = typeof value === "object" ? value.harness : (value ?? "auto");
  const choose = (next: string) => {
    if (next === "auto" || next === "self" || next === "thread") return onChange(next);
    if (!view) return;
    onChange(view.defaults[next as HarnessRoute["harness"]]);
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <select aria-label="Step runner" className={SELECT} value={kind} onChange={(event) => choose(event.target.value)}>
        <option value="auto">Auto</option>
        <option value="self">Self</option>
        <option value="thread">Thread</option>
        {view?.piAllowed !== false && <option value="pi">pi</option>}
        {view?.claude.allowed !== false && <option value="claude">claude</option>}
        {view?.cursor.allowed !== false && <option value="cursor">cursor</option>}
        {view?.codex.allowed !== false && <option value="codex">codex</option>}
      </select>
      {typeof value === "object" && value.harness === "pi" && (
        <>
          <RoutePicker
            ariaLabel="pi runner model"
            className="h-8 text-xs"
            value={{ provider: value.provider, model: value.model, ...(value.thinking ? { thinking: value.thinking } : {}) }}
            view={view}
            onChange={(route: ChatRoute | null) => route && onChange({ harness: "pi", ...route })}
          />
          <select
            aria-label="pi runner thinking"
            className={SELECT}
            value={value.thinking ?? "off"}
            onChange={(event) => onChange({ ...value, thinking: event.target.value as typeof value.thinking })}
          >
            {THINKING_LEVELS.map((level) => <option key={level} value={level}>thinking: {level}</option>)}
          </select>
        </>
      )}
      {typeof value === "object" && value.harness === "claude" && (
        <>
          <select aria-label="claude runner model" className={SELECT} value={value.model ?? ""} onChange={(event) => onChange({ ...value, model: event.target.value || undefined })}>
            <option value="">model: default</option>
            {(view?.claude.models ?? []).map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
          </select>
          <Effort value={value.effort} onChange={(effort) => onChange({ ...value, effort })} />
        </>
      )}
      {typeof value === "object" && value.harness === "cursor" && (
        <select aria-label="cursor runner model" className={SELECT} value={value.model ?? ""} onChange={(event) => onChange({ harness: "cursor", model: event.target.value || undefined })}>
          <option value="">model: default</option>
          {(view?.cursor.models ?? []).map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select>
      )}
      {typeof value === "object" && value.harness === "codex" && (
        <>
          <select aria-label="codex runner model" className={SELECT} value={value.model ?? ""} onChange={(event) => onChange({ ...value, model: event.target.value || undefined })}>
            {(view?.codex.models ?? []).map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
          </select>
          <Effort value={value.effort} onChange={(effort) => onChange({ ...value, effort })} />
        </>
      )}
    </span>
  );
}

function Effort({ value, onChange }: { value?: (typeof CLAUDE_EFFORTS)[number]; onChange: (value: (typeof CLAUDE_EFFORTS)[number] | undefined) => void }) {
  return (
    <select aria-label="Runner effort" className={SELECT} value={value ?? ""} onChange={(event) => onChange((event.target.value || undefined) as typeof value)}>
      <option value="">effort: default</option>
      {CLAUDE_EFFORTS.map((effort) => <option key={effort} value={effort}>effort: {effort}</option>)}
    </select>
  );
}
