"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { RoutePicker } from "@/components/route-picker";
import { Button } from "@/components/ui/button";
import { LABEL, MONO } from "@/components/form-styles";
import type { ModelsView } from "@/lib/providers/catalog-view";
import {
  CLAUDE_EFFORTS,
  THINKING_LEVELS,
  type ChatRoute,
  type ClaudeRoute,
  type CodexRoute,
  type CursorRoute,
  type GlobalDefaults,
  type PiRoute,
  type Surface,
} from "@/lib/providers/route";

/**
 * 0021 §6: /settings — the per-surface default routes (swap "the model
 * we use" in one place, effective on the next turn), provider
 * availability (key present or not — never the value), and the
 * OpenRouter catalog refresh. Thin client over /api/settings.
 */

const SURFACE_COPY: Record<Surface, { title: string; hint: string }> = {
  chat: { title: "Chat", hint: "New chats and conversations without their own pick." },
  agent: { title: "Agent stages", hint: "Legacy surface (machines); kept for stored defaults." },
  pi: { title: "pi harness", hint: "pi tool calls and pi stages without a conversation, stage, or project route." },
  claude: { title: "claude harness", hint: "Subscription only — never provider-routed. Model and effort." },
  cursor: { title: "cursor harness", hint: "Subscription only — never provider-routed. Model." },
  codex: { title: "codex harness", hint: "Subscription only — never provider-routed. Model and effort." },
  titles: { title: "Titles", hint: "Generated conversation titles. Keep it cheap and fast." },
};

const SELECT =
  "h-8 pointer-coarse:h-10 rounded-lg border border-border bg-background px-2 text-sm text-foreground disabled:opacity-50";

export function ModelDefaults({ initial }: { initial: ModelsView }) {
  const [view, setView] = useState(initial);
  const [defaults, setDefaults] = useState<GlobalDefaults>(initial.defaults);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const save = async (surface: Surface, route: unknown) => {
    setBusy(surface);
    setError(null);
    setNote(null);
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ surface, route }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; defaults?: GlobalDefaults };
    setBusy(null);
    if (!res.ok || !body.defaults) {
      setError(body.error ?? `failed (${res.status})`);
      return;
    }
    setDefaults(body.defaults);
    setNote(`${SURFACE_COPY[surface].title} default saved — applies from the next turn.`);
  };

  const refresh = async () => {
    setBusy("refresh");
    setError(null);
    setNote(null);
    const res = await fetch("/api/models/refresh", { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as { error?: string; count?: number };
    if (res.ok) {
      const next = await fetch("/api/settings", { cache: "no-store" });
      if (next.ok) setView((await next.json()) as ModelsView);
      setNote(`OpenRouter: ${body.count} tool-capable models.`);
    } else {
      setError(body.error ?? `refresh failed (${res.status})`);
    }
    setBusy(null);
  };

  const pickerView = { ...view, defaults };
  const providers = view.providers.filter((p) => p.available);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Providers</h2>
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {view.providers.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
              <span className="flex-1 font-medium">{p.label}</span>
              <span className={`${MONO} text-muted-foreground`}>
                {p.available ? `${p.models.length} models` : "key not set"}
              </span>
              {p.id === "openrouter" && p.available && (
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void refresh()}>
                  <RefreshCw className="size-3.5" aria-hidden /> Refresh models
                </Button>
              )}
            </li>
          ))}
          <li className="flex items-center gap-3 px-3 py-2.5 text-sm">
            <span className="flex-1 font-medium">claude (subscription)</span>
            <span className={`${MONO} text-muted-foreground`}>
              {view.claude.configured ? "token set" : "CLAUDE_CODE_OAUTH_TOKEN not set"}
            </span>
          </li>
          <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
            <span className="flex-1 font-medium">cursor (subscription)</span>
            <span className={`${MONO} text-muted-foreground`}>
              {view.cursor.configured ? loginExpiry(view.cursor.expiresAt) : "not logged in"}
            </span>
            {!view.cursor.configured && view.cursor.status && (
              <span className={`${LABEL} w-full`}>{view.cursor.status}</span>
            )}
          </li>
          {/* 0050: status only for now. 0050 phase 5: Log in with ChatGPT button. */}
          <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
            <span className="flex-1 font-medium">codex (subscription)</span>
            <span className={`${MONO} text-muted-foreground`}>
              {view.codex.configured
                ? loginExpiry(view.codex.expiresAt) + (view.codex.accountId ? ` · ${view.codex.accountId}` : "")
                : "not logged in"}
            </span>
            {!view.codex.configured && view.codex.status && (
              <span className={`${LABEL} w-full`}>{view.codex.status}</span>
            )}
          </li>
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Default models</h2>
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {(["chat", "agent", "titles"] as const).map((surface) => (
            <SurfaceRow key={surface} surface={surface}>
              <RoutePicker
                ariaLabel={`${SURFACE_COPY[surface].title} default`}
                value={defaults[surface]}
                view={pickerView}
                onChange={(route) => route && void save(surface, route)}
              />
            </SurfaceRow>
          ))}
          <SurfaceRow surface="pi">
            <PiDefault
              value={defaults.pi}
              providers={providers}
              disabled={busy !== null}
              onSave={(route) => void save("pi", route)}
              pickerView={pickerView}
            />
          </SurfaceRow>
          <SurfaceRow surface="claude">
            <ClaudeDefault
              value={defaults.claude}
              models={view.claude.models}
              disabled={busy !== null || !view.claude.configured}
              onSave={(route) => void save("claude", route)}
            />
          </SurfaceRow>
          <SurfaceRow surface="cursor">
            <CursorDefault
              value={defaults.cursor}
              models={view.cursor.models}
              disabled={busy !== null || !view.cursor.configured}
              onSave={(route) => void save("cursor", route)}
            />
          </SurfaceRow>
          <SurfaceRow surface="codex">
            <CodexDefault
              value={defaults.codex}
              models={view.codex.models}
              disabled={busy !== null || !view.codex.configured}
              onSave={(route) => void save("codex", route)}
            />
          </SurfaceRow>
        </ul>
      </section>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {note && <p className="text-sm text-muted-foreground">{note}</p>}
    </div>
  );
}

function SurfaceRow({ surface, children }: { surface: Surface; children: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2.5">
      <span className="flex min-w-48 flex-1 flex-col">
        <span className="text-sm font-medium">{SURFACE_COPY[surface].title}</span>
        <span className={LABEL}>{SURFACE_COPY[surface].hint}</span>
      </span>
      <span className="flex flex-wrap items-center gap-2">{children}</span>
    </li>
  );
}

function PiDefault({
  value,
  disabled,
  onSave,
  pickerView,
}: {
  value: PiRoute;
  providers: ModelsView["providers"];
  disabled: boolean;
  onSave: (route: PiRoute) => void;
  pickerView: ModelsView;
}) {
  const chat: ChatRoute = { provider: value.provider, model: value.model };
  return (
    <>
      <RoutePicker
        ariaLabel="pi default model"
        value={chat}
        view={pickerView}
        onChange={(route) => route && onSave({ ...value, provider: route.provider, model: route.model })}
      />
      <select
        aria-label="pi thinking level"
        className={SELECT}
        disabled={disabled}
        value={value.thinking ?? "low"}
        onChange={(e) => onSave({ ...value, thinking: e.target.value as PiRoute["thinking"] })}
      >
        {THINKING_LEVELS.map((t) => (
          <option key={t} value={t}>
            thinking: {t}
          </option>
        ))}
      </select>
    </>
  );
}

function ClaudeDefault({
  value,
  models,
  disabled,
  onSave,
}: {
  value: ClaudeRoute;
  models: { id: string; label: string }[];
  disabled: boolean;
  onSave: (route: ClaudeRoute) => void;
}) {
  const set = (patch: Partial<ClaudeRoute>) => {
    const next: ClaudeRoute = { ...value, ...patch };
    if (!next.model) delete next.model;
    if (!next.effort) delete next.effort;
    onSave(next);
  };
  return (
    <>
      <select
        aria-label="claude default model"
        className={SELECT}
        disabled={disabled}
        value={value.model ?? ""}
        onChange={(e) => set({ model: e.target.value || undefined })}
      >
        <option value="">model: subscription default</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            model: {m.label}
          </option>
        ))}
      </select>
      <select
        aria-label="claude effort"
        className={SELECT}
        disabled={disabled}
        value={value.effort ?? ""}
        onChange={(e) => set({ effort: (e.target.value || undefined) as ClaudeRoute["effort"] })}
      >
        <option value="">effort: default</option>
        {CLAUDE_EFFORTS.map((x) => (
          <option key={x} value={x}>
            effort: {x}
          </option>
        ))}
      </select>
    </>
  );
}

/** "logged in · expires in 41 days" — the access-token expiry, when known. */
function loginExpiry(expiresAt: number | null): string {
  if (expiresAt === null) return "logged in";
  const days = Math.floor((expiresAt - Date.now()) / 86_400_000);
  return days >= 0 ? `logged in · expires in ${days} day${days === 1 ? "" : "s"}` : "logged in";
}

function CursorDefault({
  value,
  models,
  disabled,
  onSave,
}: {
  value: CursorRoute;
  models: { id: string; label: string }[];
  disabled: boolean;
  onSave: (route: CursorRoute) => void;
}) {
  return (
    <select
      aria-label="cursor default model"
      className={SELECT}
      disabled={disabled}
      value={value.model ?? ""}
      onChange={(e) => onSave(e.target.value ? { harness: "cursor", model: e.target.value } : { harness: "cursor" })}
    >
      <option value="">model: Cursor default</option>
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          model: {m.label}
        </option>
      ))}
    </select>
  );
}

/** 0050: codex takes a model and an effort (shared low..max enum) — the
 *  same two-select shape as claude's row. */
function CodexDefault({
  value,
  models,
  disabled,
  onSave,
}: {
  value: CodexRoute;
  models: { id: string; label: string }[];
  disabled: boolean;
  onSave: (route: CodexRoute) => void;
}) {
  const set = (patch: Partial<CodexRoute>) => {
    const next: CodexRoute = { ...value, ...patch };
    if (!next.model) delete next.model;
    if (!next.effort) delete next.effort;
    onSave(next);
  };
  return (
    <>
      <select
        aria-label="codex default model"
        className={SELECT}
        disabled={disabled}
        value={value.model ?? ""}
        onChange={(e) => set({ model: e.target.value || undefined })}
      >
        <option value="">model: adapter default (gpt-5.5)</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            model: {m.label}
          </option>
        ))}
      </select>
      <select
        aria-label="codex effort"
        className={SELECT}
        disabled={disabled}
        value={value.effort ?? ""}
        onChange={(e) => set({ effort: (e.target.value || undefined) as CodexRoute["effort"] })}
      >
        <option value="">effort: default</option>
        {CLAUDE_EFFORTS.map((x) => (
          <option key={x} value={x}>
            effort: {x}
          </option>
        ))}
      </select>
    </>
  );
}
