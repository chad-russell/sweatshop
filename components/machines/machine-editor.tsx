"use client";

import { Braces, CircleHelp, Loader2, Network, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { parseDefinition, type MachineDefinition } from "@/lib/machines/definition";
import * as edit from "@/lib/machines/edit";
import { edgeId } from "@/lib/machines/layout";
import { cn } from "@/lib/utils";
import { usePageContext } from "@/components/page-context";
import { LazyMachineGraph } from "./machine-graph-lazy";
import { useMachineVersionSync, type MachineSnapshot } from "./use-machine-version-sync";

interface Draft {
  id: string;
  name: string;
  description: string;
  definition: unknown;
  version: number;
}

type Selection = { kind: "stage"; id: string } | { kind: "edge"; source: string; target: string } | null;

/**
 * The machine page (0014 → 0031): one draft definition, two views — the
 * read-only graph and the JSON tab. Editing is the JSON tab (and the
 * agent's edit_machine tool, which works on the same ops); the canvas
 * is a viewer with issues drawn on the stage or edge they name. Save is
 * enabled once the draft is valid.
 */
export function MachineEditor({
  initial,
  isNew = false,
  actions,
}: {
  initial: Draft;
  isNew?: boolean;
  /** Header actions (0012: Run). */
  actions?: React.ReactNode;
}) {
  const router = useRouter();
  const [id, setId] = useState(initial.id);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [draft, setDraft] = useState<MachineDefinition>(initial.definition as MachineDefinition);
  const [selection, setSelection] = useState<Selection>(null);
  const [view, setView] = useState<"graph" | "json">("graph");
  // The JSON tab's text while it doesn't parse (otherwise derived from the draft).
  const [jsonText, setJsonText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // 0015: what this draft is based on. Starts as the page's snapshot and
  // moves when the editor adopts a newer saved machine (version sync).
  const [base, setBase] = useState<MachineSnapshot>({
    name: initial.name,
    description: initial.description,
    definition: initial.definition as MachineDefinition,
    version: initial.version,
  });

  const check = useMemo(() => parseDefinition(draft), [draft]);
  const issues = useMemo(
    () => (check.ok ? null : edit.issuesByElement(draft, check.errors)),
    [check, draft],
  );
  const dirty =
    isNew ||
    name !== base.name ||
    description !== base.description ||
    JSON.stringify(draft) !== JSON.stringify(base.definition);

  /** Take a saved machine as the new base and draft (silent reload, or the
   *  stale banner's Reload). Unparsed JSON text is dropped with it. */
  const adopt = useCallback((snapshot: MachineSnapshot) => {
    setBase(snapshot);
    setDraft(snapshot.definition);
    setName(snapshot.name);
    setDescription(snapshot.description);
    setJsonText(null);
    setNotice(null);
  }, []);

  const { sync, reload } = useMachineVersionSync({
    id: isNew ? null : initial.id,
    baseVersion: base.version,
    // unparsed JSON tab text is an unsaved edit too — never drop it silently
    dirty: dirty || jsonText !== null,
    onAdopt: adopt,
  });

  const save = async () => {
    if (!check.ok || !name.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(isNew ? "/api/machines" : `/api/machines/${initial.id}`, {
        method: isNew ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(isNew && id.trim() ? { id: id.trim() } : {}),
          name,
          description,
          definition: check.definition,
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { machine?: { id: string; name: string; description: string; definition: MachineDefinition; version: number }; error?: string; details?: string[] }
        | null;
      if (!res.ok || !body?.machine) {
        throw new Error([body?.error, ...(body?.details ?? [])].filter(Boolean).join(" — ") || `save failed (${res.status})`);
      }
      if (!isNew) {
        // The saved machine is the new base — no dirty flash before the
        // router refresh re-renders the page with it.
        const saved = body.machine;
        adopt({ name: saved.name, description: saved.description, definition: saved.definition, version: saved.version });
      }
      router.push(`/machines/${body.machine.id}`);
      router.refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete machine "${initial.name}"? Its past runs are kept.`)) return;
    setBusy(true);
    const res = await fetch(`/api/machines/${initial.id}`, { method: "DELETE" });
    setBusy(false);
    if (res.ok) {
      router.push("/machines");
      router.refresh();
    } else setNotice(`delete failed (${res.status})`);
  };

  const jsonValue = jsonText ?? JSON.stringify(draft, null, 2);
  const jsonError = (() => {
    if (jsonText === null) return null;
    try {
      JSON.parse(jsonText);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  })();

  const selectedStage = selection?.kind === "stage" && draft.stages[selection.id] ? selection.id : null;
  const selectedEdge =
    selection?.kind === "edge" && draft.stages[selection.source]?.next.some((t) => t.to === selection.target)
      ? selection
      : null;

  // 0015: what the panel's "this" resolves to on this page — the machine
  // plus the selected stage or transition. Re-registers on every render,
  // so the selection a send reads is the current one.
  usePageContext(
    isNew
      ? { kind: "other" }
      : {
          kind: "machine",
          id: initial.id,
          title: name,
          selection:
            selectedStage !== null
              ? `stage ${selectedStage}`
              : selectedEdge
                ? `transition ${selectedEdge.source} → ${selectedEdge.target}`
                : undefined,
        },
  );

  return (
    <div className="flex h-dvh w-full flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-3">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Machine name"
          aria-label="Name"
          className="h-8 w-56 font-semibold"
        />
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What it does"
          aria-label="Description"
          className="h-8 min-w-48 flex-1"
        />
        {isNew ? (
          <Input
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="id (auto)"
            aria-label="Machine id"
            className="h-8 w-36 font-mono"
          />
        ) : (
          <span className="font-mono text-xs text-muted-foreground">
            {initial.id} · v{base.version}
            {sync.state === "stale" && <span className="text-warning"> → v{sync.version} saved</span>}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {!isNew && (
            <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => void remove()}>
              <Trash2 /> Delete
            </Button>
          )}
          <Button size="sm" variant={dirty ? "default" : "outline"} disabled={busy || !check.ok || !name.trim() || !dirty} onClick={() => void save()}>
            {busy && <Loader2 className="animate-spin" />}
            {isNew ? "Create" : "Save"}
          </Button>
          {!isNew && !dirty && actions}
        </div>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
        <div role="tablist" className="flex rounded-md border border-border p-0.5">
          {(
            [
              ["graph", Network, "Graph"],
              ["json", Braces, "JSON"],
            ] as const
          ).map(([key, Icon, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={view === key}
              onClick={() => setView(key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground",
                view === key && "bg-accent text-foreground",
              )}
            >
              <Icon className="size-3.5" aria-hidden />
              {label}
            </button>
          ))}
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <Button size="sm" variant="ghost" aria-label="Machine help">
              <CircleHelp />
              <span className="text-xs font-normal text-muted-foreground">
                {Object.keys(draft.stages).length} stages ·{" "}
                <span className={check.ok ? "text-success" : "text-destructive"}>{check.ok ? "valid" : "has issues"}</span>
              </span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80">
            <EditorHelp />
          </PopoverContent>
        </Popover>
        <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          Workspace
          <Select value={draft.workspace} onValueChange={(v) => setDraft((d) => edit.setWorkspace(d, v as MachineDefinition["workspace"]))}>
            <SelectTrigger size="sm" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="project">project</SelectItem>
              <SelectItem value="none">none</SelectItem>
            </SelectContent>
          </Select>
        </label>
      </div>

      {(sync.state === "stale" || sync.state === "gone") && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-3 border-b border-warning/50 px-4 py-2 text-xs text-warning"
        >
          {sync.state === "stale" ? (
            <>
              <span>This machine changed elsewhere (v{sync.version} is saved) while you have unsaved edits.</span>
              <Button size="sm" variant="outline" className="ml-auto" onClick={() => void reload()}>
                Reload (discard your changes)
              </Button>
            </>
          ) : (
            <span>This machine was deleted elsewhere. Copy out anything you want to keep — saving here will fail.</span>
          )}
        </div>
      )}

      {(issues?.general.length || notice) && (
        <div role="alert" className="shrink-0 border-b border-destructive/40 px-4 py-2 font-mono text-xs text-destructive">
          {notice && <p>{notice}</p>}
          {issues?.general.map((m) => <p key={m}>{m}</p>)}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        {view === "graph" ? (
          <div className="min-h-0 min-w-0 flex-1">
            <LazyMachineGraph
              definition={draft}
              issues={issues ?? undefined}
              selection={{
                node: selectedStage,
                edge: selectedEdge ? edgeId(selectedEdge.source, selectedEdge.target) : null,
              }}
              onSelectNode={(nid) => setSelection(nid ? { kind: "stage", id: nid } : null)}
              onSelectEdge={(e) => setSelection(e ? { kind: "edge", source: e.source, target: e.target } : null)}
            />
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col gap-2 p-4">
            <Textarea
              value={jsonValue}
              onChange={(e) => {
                const text = e.target.value;
                setJsonText(text);
                try {
                  // Parsed JSON becomes the draft (validity is checked
                  // separately) — if it is at least graph-shaped, so the
                  // graph can walk it.
                  const parsed: unknown = JSON.parse(text);
                  if (isGraphShaped(parsed)) setDraft(parsed);
                } catch {
                  /* keep the text; the draft stays at the last parse */
                }
              }}
              spellCheck={false}
              aria-invalid={Boolean(jsonError) || !check.ok}
              className="min-h-0 flex-1 resize-none font-mono text-xs"
            />
            {jsonError && <p className="font-mono text-xs text-destructive">JSON: {jsonError}</p>}
            {!jsonError && jsonText !== null && !isGraphShaped(JSON.parse(jsonText)) && (
              <p className="font-mono text-xs text-destructive">
                Not a machine shape yet (needs stages with next arrays) — the graph keeps the last good draft.
              </p>
            )}
            {!check.ok && (
              <ul className="flex flex-col gap-0.5 font-mono text-xs text-destructive">
                {check.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Enough structure to draw: an object of stages with `next`
 *  arrays. Anything finer is the validator's job. */
function isGraphShaped(value: unknown): value is MachineDefinition {
  if (!value || typeof value !== "object") return false;
  const stages = (value as { stages?: unknown }).stages;
  if (!stages || typeof stages !== "object" || Array.isArray(stages)) return false;
  return Object.values(stages).every(
    (s) =>
      s !== null &&
      typeof s === "object" &&
      Array.isArray((s as { next?: unknown }).next) &&
      (s as { next: unknown[] }).next.every((t) => t !== null && typeof t === "object" && typeof (t as { to?: unknown }).to === "string"),
  );
}

function EditorHelp() {
  return (
    <ul className="flex list-disc flex-col gap-1.5 pl-4 text-xs text-muted-foreground">
      <li>The canvas is a read-only view (0031). Edit the JSON, or ask the agent panel to edit this machine.</li>
      <li>Selecting a stage or transition sets the panel&rsquo;s &ldquo;viewing&rdquo; context.</li>
      <li>A stage with no transitions ends the run (dashed line to end).</li>
      <li>Problems show in red on the stage or transition they belong to.</li>
    </ul>
  );
}
