"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import type { PreviewSetupDefinition } from "@/lib/previews/setup";
import {
  definitionFromSetupForm,
  emptySetupForm,
  FIELD,
  LABEL,
  setupFormFromDefinition,
  SetupFields,
  type SetupFormValues,
} from "@/components/previews/setup-editor";

/**
 * 0018 phase 2: the saved setup's permanent home — the project page.
 * The same SetupFields the New-preview flow fills at create time,
 * editing the definition in place (PUT /api/previews/setup). Creating
 * a first setup here is allowed too; the New-preview dialog remains
 * the create-with-launch path.
 */
export function ProjectSetupEditor({
  projectId,
  repos,
  initialDefinition,
  storedIssues,
}: {
  projectId: string;
  repos: { id: string; name: string }[];
  initialDefinition: PreviewSetupDefinition | null;
  /** When the stored row fails validation, why (the editor starts empty). */
  storedIssues?: string[];
}) {
  const router = useRouter();
  const ids = useId();
  const [repoId, setRepoId] = useState(initialDefinition?.repo ?? repos[0]?.id ?? "");
  const [values, setValues] = useState<SetupFormValues>(
    initialDefinition ? setupFormFromDefinition(initialDefinition) : emptySetupForm,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const complete = Boolean(values.command.trim() && values.install.trim() && values.port.trim());

  const save = async () => {
    if (!repoId) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    const built = definitionFromSetupForm(values, repoId);
    if ("error" in built) {
      setBusy(false);
      setError(built.error);
      return;
    }
    const res = await fetch("/api/previews/setup", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, definition: built.definition }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!res.ok) {
      setError(body.error ?? `could not save (${res.status})`);
      return;
    }
    setSaved(true);
    router.refresh();
  };

  if (repos.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        A setup needs a repo — add one under Repos above and the editor appears here.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      {storedIssues && (
        <p className="text-sm text-destructive">The stored setup is invalid: {storedIssues.join("; ")}</p>
      )}
      <label className={FIELD} htmlFor={`${ids}-repo`}>
        <span className={LABEL}>Repo the setup runs</span>
        <select
          id={`${ids}-repo`}
          value={repoId}
          onChange={(e) => {
            setRepoId(e.target.value);
            setSaved(false);
          }}
          className="h-9 rounded-md border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <SetupFields ids={ids} values={values} onChange={(next) => { setValues(next); setSaved(false); }} />
      {error && <p className="text-sm text-destructive">{error}</p>}
      {saved && <p className="text-sm text-muted-foreground">Saved — applies to the next preview launch.</p>}
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={busy || !repoId || !complete} onClick={() => void save()}>
          {busy ? "Saving…" : initialDefinition ? "Save setup" : "Create setup"}
        </Button>
        <span className="text-xs text-muted-foreground">
          Applies to every later preview and start_preview in this project.
        </span>
      </div>
    </div>
  );
}
