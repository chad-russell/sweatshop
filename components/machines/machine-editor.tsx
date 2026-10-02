"use client";

import { Loader2, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { parseDefinition, type MachineDefinition } from "@/lib/machines/definition";
import { LazyMachineGraph } from "./machine-graph-lazy";

interface Draft {
  id: string;
  name: string;
  description: string;
  definition: unknown;
  version: number;
}

/**
 * The v1 machine editor (0009): name, description, and the definition
 * as JSON, validated live with the same schema the store enforces.
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
  const [text, setText] = useState(() => JSON.stringify(initial.definition, null, 2));
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const check = useMemo(() => {
    try {
      return parseDefinition(JSON.parse(text));
    } catch (err) {
      return { ok: false as const, errors: [`JSON: ${err instanceof Error ? err.message : String(err)}`] };
    }
  }, [text]);

  // The graph shows the last definition that parsed, so a typo mid-edit
  // doesn't blank it.
  const [lastValid, setLastValid] = useState<MachineDefinition>(initial.definition as MachineDefinition);
  if (check.ok && check.definition !== lastValid && JSON.stringify(check.definition) !== JSON.stringify(lastValid)) {
    setLastValid(check.definition);
  }

  const save = async () => {
    if (!check.ok || !name.trim()) return;
    setBusy(true);
    setServerError(null);
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
        | { machine?: { id: string }; error?: string; details?: string[] }
        | null;
      if (!res.ok || !body?.machine) {
        throw new Error([body?.error, ...(body?.details ?? [])].filter(Boolean).join(" — ") || `save failed (${res.status})`);
      }
      router.push(`/machines/${body.machine.id}`);
      router.refresh();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "save failed");
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
    } else setServerError(`delete failed (${res.status})`);
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">{isNew ? "New machine" : initial.name}</h1>
        {!isNew && (
          <span className="flex items-center gap-3">
            <span className="font-mono text-xs text-muted-foreground">
              {initial.id} · v{initial.version}
            </span>
            {actions}
          </span>
        )}
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        {isNew && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Id (optional, kebab-case)</span>
            <Input value={id} onChange={(e) => setId(e.target.value)} className="font-mono" placeholder="auto" />
          </label>
        )}
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Description</span>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>

      <div className="h-80 overflow-hidden rounded-lg border border-border">
        <LazyMachineGraph definition={lastValid} />
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">
          Definition — stages are <code className="font-mono">harness</code> (pi | claude, project only),{" "}
          <code className="font-mono">agent</code>, or <code className="font-mono">human</code>;{" "}
          <code className="font-mono">next</code> lists targets, <code className="font-mono">end</code> finishes.
        </span>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          className="min-h-96 font-mono text-xs"
          aria-invalid={!check.ok}
        />
      </label>

      {!check.ok && (
        <ul role="alert" className="flex flex-col gap-0.5 font-mono text-xs text-destructive">
          {check.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {serverError && (
        <p role="alert" className="text-sm text-destructive">
          {serverError}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button disabled={busy || !check.ok || !name.trim()} onClick={() => void save()}>
          {busy && <Loader2 className="animate-spin" />}
          {isNew ? "Create" : "Save"}
        </Button>
        {!isNew && (
          <Button variant="ghost" className="ml-auto text-destructive" disabled={busy} onClick={() => void remove()}>
            <Trash2 /> Delete
          </Button>
        )}
      </div>
    </div>
  );
}
