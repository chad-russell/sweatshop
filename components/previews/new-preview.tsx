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

/**
 * 0016 phase 3: New preview — project → repo → branch (listed from the
 * host when it can be; typed otherwise), with optional command / port /
 * label overrides (blank = the project's config defaults, else inferred
 * from package.json). Creating waits until the preview serves or parks
 * as failed (the list shows which), then closes.
 */

interface Repo {
  id: string;
  name: string;
  url: string;
}

const FIELD = "flex flex-col gap-1.5 text-sm";
const LABEL = "text-xs font-medium text-muted-foreground";
const SELECT =
  "h-9 rounded-md border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50";

export function NewPreviewForm({ projects }: { projects: { id: string; name: string }[] }) {
  const router = useRouter();
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoId, setRepoId] = useState("");
  const [branches, setBranches] = useState<string[] | null>(null);
  const [branch, setBranch] = useState("");
  const [command, setCommand] = useState("");
  const [port, setPort] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Repos for the chosen project (reset the repo + branch below it).
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
      const body = (await res.json().catch(() => ({ branches: [] }))) as { branches: string[] };
      if (cancelled) return;
      setBranches(body.branches);
      setBranch((current) => current || (body.branches.includes("main") ? "main" : (body.branches[0] ?? "")));
    })();
    return () => {
      cancelled = true;
    };
  }, [open, projectId, repoId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/previews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, repoId, branch, command, port, label }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; preview?: { id: string } };
    setBusy(false);
    if (!res.ok) {
      setError(body.error ?? `could not create (${res.status})`);
      return;
    }
    setOpen(false);
    router.push(body.preview ? `/previews?id=${body.preview.id}` : "/previews");
    router.refresh();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={projects.length === 0} title={projects.length === 0 ? "No project has a repo yet" : undefined}>
          <Plus /> New preview
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New branch preview</DialogTitle>
            <DialogDescription>
              A dedicated sandbox serves the branch and redeploys every time it moves. Failures land in your Inbox.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <label className={FIELD} htmlFor={`${ids}-project`}>
              <span className={LABEL}>Project</span>
              <select
                id={`${ids}-project`}
                className={SELECT}
                value={projectId}
                onChange={(e) => {
                  setProjectId(e.target.value);
                  setBranch("");
                  setBranches(null);
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
                className={SELECT}
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
              Branch{branches === null ? " (loading…)" : branches.length === 0 ? " (couldn't list — type it)" : ""}
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

          <details className="text-sm">
            <summary className="cursor-pointer text-xs text-muted-foreground">Command, port, label (optional)</summary>
            <div className="mt-3 flex flex-col gap-3">
              <label className={FIELD} htmlFor={`${ids}-command`}>
                <span className={LABEL}>Command — blank infers from package.json</span>
                <Input
                  id={`${ids}-command`}
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="pnpm install && pnpm dev --host 0.0.0.0 --port 3000"
                  className="font-mono text-xs"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className={FIELD} htmlFor={`${ids}-port`}>
                  <span className={LABEL}>Port</span>
                  <Input id={`${ids}-port`} value={port} onChange={(e) => setPort(e.target.value)} placeholder="3000" inputMode="numeric" className="font-mono" />
                </label>
                <label className={FIELD} htmlFor={`${ids}-label`}>
                  <span className={LABEL}>Label</span>
                  <Input id={`${ids}-label`} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={branch || "branch name"} />
                </label>
              </div>
            </div>
          </details>

          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={busy || !projectId || !repoId || !branch.trim()}>
              {busy ? "Starting — cloning, installing, booting…" : "Create preview"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
