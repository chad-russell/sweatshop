"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { parseEnvBlock } from "@/lib/previews/env";
import type { PreviewSetupDefinition } from "@/lib/previews/setup";
import {
  definitionFromSetupForm,
  emptySetupForm,
  FIELD,
  LABEL,
  MONO,
  setupFormFromDefinition,
  SetupFields,
  type SetupFormValues,
} from "@/components/previews/setup-editor";

/**
 * 0017: New preview, two-phase. Project → repo → branch, then Create:
 * with the project's saved setup (or explicit values) it provisions and
 * launches in one shot; otherwise it provisions, SCANS the checkout
 * (Discover), and you pick/edit a candidate. The field set IS the full
 * setup definition (0017 amendment): structural fields (workDir,
 * install, provision, seed, services, env) save to the project's setup
 * on confirm — there is no toggle — while command/port/label stay this
 * preview's row. Provisioning failures are visible rows on /previews,
 * never silent 500s.
 */

interface Repo {
  id: string;
  name: string;
  url: string;
}

interface Candidate {
  dir: string;
  pm: string;
  script: string;
  command: string;
  install: string;
  port: number;
  seed?: string;
}

export function NewPreviewForm({ projects }: { projects: { id: string; name: string }[] }) {
  const router = useRouter();
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoId, setRepoId] = useState("");
  const [branches, setBranches] = useState<string[] | null>(null);
  const [branchWarning, setBranchWarning] = useState<string | null>(null);
  const [branch, setBranch] = useState("");

  const [hasSetup, setHasSetup] = useState(false);
  const [values, setValues] = useState<SetupFormValues>(emptySetupForm);
  const [label, setLabel] = useState("");

  const [step, setStep] = useState<"form" | "discover">("form");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [picked, setPicked] = useState(0);
  const [busy, setBusy] = useState<null | "create" | "confirm">(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setStep("form");
    setPendingId(null);
    setCandidates([]);
    setPicked(0);
    setBusy(null);
    setError(null);
    setHasSetup(false);
    setValues(emptySetupForm);
    setLabel("");
  };

  // Repos + the project's saved setup (reset the repo + branch below).
  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/branches`, { cache: "no-store" });
      const body = (await res.json().catch(() => ({ repos: [] }))) as { repos: Repo[] };
      if (cancelled) return;
      setRepos(body.repos);
      setRepoId(body.repos[0]?.id ?? "");
    })();
    void (async () => {
      const res = await fetch(`/api/previews/setup?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
      const body = (await res.json().catch(() => ({ setup: null }))) as { setup: { definition: PreviewSetupDefinition } | null };
      if (cancelled) return;
      const definition = body.setup?.definition ?? null;
      setHasSetup(Boolean(definition));
      setValues(definition ? setupFormFromDefinition(definition) : emptySetupForm);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  // Branches for the chosen repo (null while loading).
  useEffect(() => {
    if (!open || !projectId || !repoId) return;
    let cancelled = false;
    void (async () => {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/branches?repo=${encodeURIComponent(repoId)}`,
        { cache: "no-store" },
      );
      const body = (await res.json().catch(() => ({ branches: [] }))) as { branches: string[]; warning?: string | null };
      if (cancelled) return;
      setBranches(body.branches);
      setBranchWarning(body.warning ?? null);
      setBranch((current) => current || (body.branches.includes("main") ? "main" : (body.branches[0] ?? "")));
    })();
    return () => {
      cancelled = true;
    };
  }, [open, projectId, repoId]);

  // Abandoning a discovered (provisioning) preview deletes it.
  const close = (next: boolean) => {
    if (busy) return;
    setOpen(next);
    if (!next) {
      if (pendingId) {
        void fetch(`/api/previews/${pendingId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "delete" }),
        });
      }
      reset();
    }
  };

  const applyCandidate = (i: number) => {
    setPicked(i);
    const c = candidates[i];
    if (!c) return;
    setValues((current) => ({
      ...current,
      workDir: c.dir,
      install: c.install,
      command: c.command,
      port: String(c.port),
      // a discovered seed script prefill never wipes a loaded setup's
      // seed — it fills only when the field is empty
      ...(c.seed && !current.seed ? { seed: c.seed } : {}),
    }));
  };

  /** The full body both create and confirm send: every structural
   *  field when the definition resolves, per-preview fields always. */
  const body = () => {
    const definition = definitionFromSetupForm(values, repoId);
    if ("error" in definition) return definition;
    const d = definition.definition;
    const env = parseEnvBlock(values.envText);
    if ("error" in env) return env;
    return {
      ...(values.workDir.trim() ? { workDir: d.workDir } : {}),
      ...(values.install.trim() ? { install: d.install } : {}),
      ...(values.command.trim() ? { command: d.command } : {}),
      ...(values.port.trim() ? { port: d.port } : {}),
      ...(label.trim() ? { label: label.trim() } : {}),
      ...(d.provision ? { provision: d.provision } : {}),
      ...(d.seed ? { seed: d.seed } : {}),
      ...(d.services.length ? { services: d.services } : {}),
      ...(d.env && Object.keys(d.env).length ? { env: d.env } : {}),
    };
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("create");
    setError(null);
    const b = body();
    if ("error" in b) {
      setBusy(null);
      setError(b.error);
      return;
    }
    const res = await fetch("/api/previews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, repoId, branch, ...b }),
    });
    const parsed = (await res.json().catch(() => ({}))) as {
      error?: string;
      preview?: { id: string; status: string };
      candidates?: Candidate[];
    };
    setBusy(null);
    if (!res.ok) {
      setError(parsed.error ?? `could not create (${res.status})`);
      return;
    }
    if (parsed.candidates?.length) {
      setPendingId(parsed.preview!.id);
      setCandidates(parsed.candidates);
      applyCandidate(0);
      setStep("discover");
      return;
    }
    setOpen(false);
    reset();
    router.push(parsed.preview ? `/previews?id=${parsed.preview.id}` : "/previews");
    router.refresh();
  };

  const confirm = async () => {
    if (!pendingId) return;
    setBusy("confirm");
    setError(null);
    const b = body();
    if ("error" in b) {
      setBusy(null);
      setError(b.error);
      return;
    }
    const res = await fetch(`/api/previews/${pendingId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "confirm", ...b }),
    });
    const parsed = (await res.json().catch(() => ({}))) as { error?: string; preview?: { id: string } };
    setBusy(null);
    if (!res.ok || parsed.error) {
      setError(parsed.error ?? `could not launch (${res.status})`);
      return;
    }
    setOpen(false);
    reset();
    router.push(`/previews?id=${pendingId}`);
    router.refresh();
  };

  const saveSetupOnly = async () => {
    if (!projectId || !repoId) return;
    setBusy("create");
    setError(null);
    const built = definitionFromSetupForm(values, repoId);
    if ("error" in built) {
      setBusy(null);
      setError(built.error);
      return;
    }
    const res = await fetch("/api/previews/setup", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, definition: built.definition }),
    });
    const parsed = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(null);
    if (!res.ok) {
      setError(parsed.error ?? `could not save (${res.status})`);
      return;
    }
    setOpen(false);
    reset();
    router.refresh();
  };

  const resolvable = Boolean(values.command.trim() && values.install.trim() && values.port.trim());

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={projects.length === 0} title={projects.length === 0 ? "No project has a repo yet" : undefined}>
          <Plus /> New preview
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{step === "discover" ? "Pick what to preview" : "New branch preview"}</DialogTitle>
            <DialogDescription>
              {step === "discover"
                ? "Scanned the checkout — pick a package; edit and launch. Structural fields save as the project's setup."
                : "A dedicated sandbox serves the branch and redeploys every time it moves. Failures land in your Inbox."}
            </DialogDescription>
          </DialogHeader>

          {step === "form" ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <label className={FIELD} htmlFor={`${ids}-project`}>
                  <span className={LABEL}>Project</span>
                  <select
                    id={`${ids}-project`}
                    className="h-9 rounded-md border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                    value={projectId}
                    onChange={(e) => {
                      setProjectId(e.target.value);
                      setBranch("");
                      setBranches(null);
                      setHasSetup(false);
                      setValues(emptySetupForm);
                    }}
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={FIELD} htmlFor={`${ids}-repo`}>
                  <span className={LABEL}>Repo</span>
                  <select
                    id={`${ids}-repo`}
                    className="h-9 rounded-md border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                    value={repoId}
                    disabled={repos.length === 0}
                    onChange={(e) => {
                      setRepoId(e.target.value);
                      setBranch("");
                      setBranches(null);
                    }}
                  >
                    {repos.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className={FIELD} htmlFor={`${ids}-branch`}>
                <span className={LABEL}>
                  Branch
                  {branches === null
                    ? " (loading…)"
                    : branches.length === 0
                      ? branchWarning
                        ? ` — ${branchWarning}`
                        : " (couldn't list — type it)"
                      : ""}
                </span>
                <Input
                  id={`${ids}-branch`}
                  list={`${ids}-branches`}
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="main"
                  required
                  autoComplete="off"
                  className="font-mono"
                />
                <datalist id={`${ids}-branches`}>
                  {(branches ?? []).map((b) => (
                    <option key={b} value={b} />
                  ))}
                </datalist>
              </label>

              <details className="text-sm" open={hasSetup || Boolean(values.command)}>
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  {hasSetup
                    ? "Saved setup — edits save back to the project's setup"
                    : "Command, install, port… (optional — or we scan and ask)"}
                </summary>
                <div className="mt-3 flex flex-col gap-3">
                  <SetupFields ids={ids} values={values} onChange={setValues} />
                  <label className={FIELD} htmlFor={`${ids}-label`}>
                    <span className={LABEL}>Label (this preview only)</span>
                    <Input id={`${ids}-label`} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={branch || "branch name"} />
                  </label>
                </div>
              </details>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Preview candidates">
                {candidates.map((c, i) => (
                  <label
                    key={c.dir}
                    className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm ${
                      i === picked ? "border-ring bg-accent" : "border-input"
                    }`}
                  >
                    <input type="radio" name="candidate" checked={i === picked} onChange={() => applyCandidate(i)} className="mt-1 accent-foreground" />
                    <span className="flex flex-col gap-0.5">
                      <span className={MONO}>{c.dir === "." ? "repo root" : c.dir}</span>
                      <span className="text-xs text-muted-foreground">
                        {c.pm} run {c.script} · port {c.port}
                        {c.seed ? " · seed script found" : ""}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              <div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto pr-1">
                <SetupFields ids={ids} values={values} onChange={setValues} />
                <label className={FIELD} htmlFor={`${ids}-d-label`}>
                  <span className={LABEL}>Label (this preview only)</span>
                  <Input id={`${ids}-d-label`} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={branch} />
                </label>
              </div>
            </>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            {step === "form" ? (
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={Boolean(busy) || !resolvable}
                  title="Save these values as the project's setup — no preview launched"
                  onClick={() => void saveSetupOnly()}
                >
                  Save setup only
                </Button>
                <Button type="submit" disabled={Boolean(busy) || !projectId || !repoId || !branch.trim()}>
                  {busy === "create"
                    ? resolvable
                      ? "Provisioning, installing, launching…"
                      : "Provisioning & scanning…"
                    : hasSetup || resolvable
                      ? "Create preview"
                      : "Create & discover"}
                </Button>
              </div>
            ) : (
              <Button type="button" disabled={busy !== null || !resolvable} onClick={() => void confirm()}>
                {busy === "confirm" ? "Installing & launching…" : "Launch preview"}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
