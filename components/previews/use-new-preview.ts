"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import {
  emptySetupForm,
  isLaunchable,
  overridesFromSetupForm,
  setupFormFromDefinition,
  type SetupFormValues,
} from "@/components/project/setup-form";
import type { PreviewSetupDefinition } from "@/lib/previews/setup";

/**
 * 0017/0019: the New-preview flow's state — everything but the markup.
 * Project → repo → branch, then Create; with the project's saved setup
 * the request carries only the label (the setup is edited on the
 * project page); with none (first fill) it provisions, scans, and the
 * confirmed values become the project's setup. Abandoning a discovered
 * (provisioning) preview deletes it. See new-preview.tsx for the UI.
 */

export interface Repo {
  id: string;
  name: string;
  url: string;
}

export interface Candidate {
  dir: string;
  pm: string;
  script: string;
  command: string;
  install: string;
  port: number;
  seed?: string;
}

type Busy = null | "create" | "confirm";

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export function useNewPreview(projects: { id: string; name: string }[]) {
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
  const [setupRepoId, setSetupRepoId] = useState<string | null>(null);
  const [values, setValues] = useState<SetupFormValues>(emptySetupForm);
  const [label, setLabel] = useState("");

  const [step, setStep] = useState<"form" | "discover">("form");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [picked, setPicked] = useState(0);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  const resetSetup = () => {
    setHasSetup(false);
    setSetupRepoId(null);
    setValues(emptySetupForm);
  };

  const reset = () => {
    setStep("form");
    setPendingId(null);
    setCandidates([]);
    setPicked(0);
    setBusy(null);
    setError(null);
    resetSetup();
    setLabel("");
  };

  // Repos + the project's saved setup.
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
      const body = (await res.json().catch(() => ({ setup: null }))) as {
        setup: { definition: PreviewSetupDefinition } | null;
      };
      if (cancelled) return;
      const definition = body.setup?.definition ?? null;
      setHasSetup(Boolean(definition));
      setSetupRepoId(definition?.repo ?? null);
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
      const body = (await res.json().catch(() => ({ branches: [] }))) as {
        branches: string[];
        warning?: string | null;
      };
      if (cancelled) return;
      setBranches(body.branches);
      setBranchWarning(body.warning ?? null);
      setBranch((current) => current || (body.branches.includes("main") ? "main" : (body.branches[0] ?? "")));
    })();
    return () => {
      cancelled = true;
    };
  }, [open, projectId, repoId]);

  const close = (next: boolean) => {
    if (busy) return;
    setOpen(next);
    if (!next) {
      if (pendingId) void post(`/api/previews/${pendingId}`, { action: "delete" });
      reset();
    }
  };

  const chooseProject = (id: string) => {
    setProjectId(id);
    setBranch("");
    setBranches(null);
    resetSetup();
  };

  const chooseRepo = (id: string) => {
    setRepoId(id);
    setBranch("");
    setBranches(null);
  };

  const applyCandidate = (i: number, list: Candidate[] = candidates) => {
    setPicked(i);
    const c = list[i];
    if (!c) return;
    setValues((current) => ({
      ...current,
      workDir: c.dir,
      install: c.install,
      command: c.command,
      port: String(c.port),
      // a discovered seed prefill never wipes a value already there
      ...(c.seed && !current.seed ? { seed: c.seed } : {}),
    }));
  };

  /** What create and confirm send: just the label when a setup exists,
   *  else the editor's whole definition (it becomes the project's). */
  const body = (): Record<string, unknown> | { error: string } =>
    hasSetup ? (label.trim() ? { label: label.trim() } : {}) : overridesFromSetupForm(values, repoId, label);

  const finish = (previewId?: string) => {
    setOpen(false);
    reset();
    router.push(previewId ? `/previews?id=${previewId}` : "/previews");
    router.refresh();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const b = body();
    if ("error" in b) return setError(b.error as string);
    setBusy("create");
    setError(null);
    const res = await post("/api/previews", { projectId, repoId, branch, ...b });
    const parsed = (await res.json().catch(() => ({}))) as {
      error?: string;
      preview?: { id: string };
      candidates?: Candidate[];
    };
    setBusy(null);
    if (!res.ok) return setError(parsed.error ?? `could not create (${res.status})`);
    if (parsed.candidates?.length) {
      setPendingId(parsed.preview!.id);
      setCandidates(parsed.candidates);
      applyCandidate(0, parsed.candidates);
      setStep("discover");
      return;
    }
    finish(parsed.preview?.id);
  };

  const confirm = async () => {
    if (!pendingId) return;
    const b = body();
    if ("error" in b) return setError(b.error as string);
    setBusy("confirm");
    setError(null);
    const res = await post(`/api/previews/${pendingId}`, { action: "confirm", ...b });
    const parsed = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(null);
    if (!res.ok || parsed.error) return setError(parsed.error ?? `could not launch (${res.status})`);
    const id = pendingId;
    setPendingId(null); // launched — closing must not delete it
    finish(id);
  };

  return {
    ids,
    open,
    close,
    step,
    busy,
    error,
    projectId,
    chooseProject,
    repos,
    repoId,
    chooseRepo,
    branches,
    branchWarning,
    branch,
    setBranch,
    label,
    setLabel,
    hasSetup,
    setupRepoId,
    values,
    setValues,
    candidates,
    picked,
    applyCandidate,
    launchable: isLaunchable(values),
    submit,
    confirm,
  };
}
