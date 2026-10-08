"use client";

import { FolderPlus, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
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
import { FIELD, LABEL, MONO } from "@/components/form-styles";
import { cn } from "@/lib/utils";

/**
 * 0033 B-UI: the New-project dialog — the UI half of the createProject
 * core (the agent's create_project is the other). Mounted as a sidebar
 * nav row; the ⌘K palette opens it through NEW_PROJECT_EVENT. Five
 * fields: id, name, and repo rows whose name auto-fills from the URL's
 * last path segment. On success it redirects to the project page,
 * where the work-defaults and models cards finish the setup.
 */

export const NEW_PROJECT_EVENT = "sweatshop:new-project";

interface RepoRow {
  name: string;
  url: string;
}

const nameFromUrl = (url: string): string => {
  const clean = url.trim().replace(/\.git$/, "");
  const last = clean.split("/").filter(Boolean).pop() ?? "";
  return last.replace(/[^a-zA-Z0-9._-]/g, "");
};

export function NewProjectButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [repos, setRepos] = useState<RepoRow[]>([{ name: "", url: "" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onNewProject = () => setOpen(true);
    window.addEventListener(NEW_PROJECT_EVENT, onNewProject);
    return () => window.removeEventListener(NEW_PROJECT_EVENT, onNewProject);
  }, []);

  const setRepo = (i: number, patch: Partial<RepoRow>) => {
    setRepos((rows) =>
      rows.map((row, j) => {
        if (i !== j) return row;
        const next = { ...row, ...patch };
        if (patch.url !== undefined && !row.name) next.name = nameFromUrl(patch.url);
        return next;
      }),
    );
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: id.trim(),
          name: name.trim(),
          repos: repos.filter((r) => r.url.trim()).map((r) => ({ name: r.name.trim(), url: r.url.trim() })),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; project?: { id: string } };
      if (!res.ok || !body.project) {
        setError(body.error ?? `failed (${res.status})`);
        return;
      }
      setOpen(false);
      router.push(`/p/${encodeURIComponent(body.project.id)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
        >
          <FolderPlus className="size-4 shrink-0 text-sidebar-foreground/60" />
          <span className="flex-1 text-left">New project</span>
        </button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              Repos clone into every project sandbox; the test command, branch prefix, and models are set on the next screen.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <label className={FIELD} htmlFor="new-project-id">
              <span className={LABEL}>Id</span>
              <Input
                id="new-project-id"
                value={id}
                onChange={(e) => setId(e.target.value.toLowerCase())}
                placeholder="gpl"
                className={MONO}
                required
              />
            </label>
            <label className={FIELD} htmlFor="new-project-name">
              <span className={LABEL}>Name</span>
              <Input
                id="new-project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="GPL"
                required
              />
            </label>
          </div>

          <div className="flex flex-col gap-2">
            <span className={LABEL}>Repos</span>
            {repos.map((repo, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  aria-label={`Repo ${i + 1} clone name`}
                  value={repo.name}
                  onChange={(e) => setRepo(i, { name: e.target.value })}
                  placeholder="360-gpl"
                  className={cn(MONO, "w-40 shrink-0")}
                />
                <Input
                  aria-label={`Repo ${i + 1} URL`}
                  value={repo.url}
                  onChange={(e) => setRepo(i, { url: e.target.value })}
                  placeholder="https://github.com/TangoGroup/360-gpl"
                  className={MONO}
                />
                <button
                  type="button"
                  aria-label={`Remove repo ${i + 1}`}
                  onClick={() => setRepos((rows) => rows.filter((_, j) => j !== i))}
                  disabled={repos.length === 1}
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="self-start"
              onClick={() => setRepos((rows) => [...rows, { name: "", url: "" }])}
            >
              <Plus /> Add repo
            </Button>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="submit" disabled={busy || !id.trim() || !name.trim()}>
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
