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

/**
 * 0017: New preview, two-phase. Project → repo → branch, then Create:
 * with the project's saved setup (or explicit values) it provisions and
 * launches in one shot; otherwise it provisions, SCANS the checkout
 * (Discover), and you pick/edit a candidate — workDir, install,
 * command, port, env — optionally saving it as the project's setup so
 * the next create is one click. Provisioning failures are visible rows
 * on /previews, never silent 500s.
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
}

interface Setup {
  workDir: string;
  install: string;
  command: string;
  port: number;
  env?: Record<string, string>;
}

const FIELD = "flex flex-col gap-1.5 text-sm";
const LABEL = "text-xs font-medium text-muted-foreground";
const SELECT =
  "h-9 rounded-md border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50";
const MONO = "font-mono text-xs";

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

  const [setup, setSetup] = useState<Setup | null>(null);
  const [workDir, setWorkDir] = useState("");
  const [install, setInstall] = useState("");
  const [command, setCommand] = useState("");
  const [port, setPort] = useState("");
  const [label, setLabel] = useState("");
  const [envText, setEnvText] = useState("");
  const [saveSetup, setSaveSetup] = useState(true);

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
    setSetup(null);
    setWorkDir("");
    setInstall("");
    setCommand("");
    setPort("");
    setLabel("");
    setEnvText("");
    setSaveSetup(true);
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
      const body = (await res.json().catch(() => ({ setup: null }))) as { setup: { definition: Setup } | null };
      if (cancelled) return;
      const definition = body.setup?.definition ?? null;
      setSetup(definition);
      setSaveSetup(!definition);
      if (definition) {
        setWorkDir(definition.workDir);
        setInstall(definition.install);
        setCommand(definition.command);
        setPort(String(definition.port));
        setEnvText(
          Object.entries(definition.env ?? {})
            .map(([k, v]) => `${k}=${v.includes(" ") ? JSON.stringify(v) : v}`)
            .join("\n"),
        );
      }
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
    setWorkDir(c.dir);
    setInstall(c.install);
    setCommand(c.command);
    setPort(String(c.port));
  };

  const parsedEnv = () => parseEnvBlock(envText);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("create");
    setError(null);
    const env = parsedEnv();
    if ("error" in env) {
      setBusy(null);
      setError(env.error);
      return;
    }
    const res = await fetch("/api/previews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId,
        repoId,
        branch,
        ...(workDir ? { workDir } : {}),
        ...(install ? { install } : {}),
        ...(command ? { command } : {}),
        ...(port ? { port: Number(port) } : {}),
        ...(label ? { label } : {}),
        ...(env.env && Object.keys(env.env).length ? { env: env.env } : {}),
        ...(saveSetup ? { saveSetup: true } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      preview?: { id: string; status: string };
      candidates?: Candidate[];
    };
    setBusy(null);
    if (!res.ok) {
      setError(body.error ?? `could not create (${res.status})`);
      return;
    }
    if (body.candidates?.length) {
      setPendingId(body.preview!.id);
      setCandidates(body.candidates);
      applyCandidate(0);
      setStep("discover");
      return;
    }
    setOpen(false);
    reset();
    router.push(body.preview ? `/previews?id=${body.preview.id}` : "/previews");
    router.refresh();
  };

  const confirm = async () => {
    if (!pendingId) return;
    setBusy("confirm");
    setError(null);
    const env = parsedEnv();
    if ("error" in env) {
      setBusy(null);
      setError(env.error);
      return;
    }
    const res = await fetch(`/api/previews/${pendingId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "confirm",
        ...(workDir ? { workDir } : {}),
        ...(install ? { install } : {}),
        ...(command ? { command } : {}),
        ...(port ? { port: Number(port) } : {}),
        ...(label ? { label } : {}),
        env: env.env ?? {},
        ...(saveSetup ? { saveSetup: true } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; preview?: { id: string } };
    setBusy(null);
    if (!res.ok || body.error) {
      setError(body.error ?? `could not launch (${res.status})`);
      return;
    }
    setOpen(false);
    reset();
    router.push(`/previews?id=${pendingId}`);
    router.refresh();
  };

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
                ? "Scanned the checkout — pick a package; edit, save as this project's setup, and launch."
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
                    className={SELECT}
                    value={projectId}
                    onChange={(e) => {
                      setProjectId(e.target.value);
                      setBranch("");
                      setBranches(null);
                      setSetup(null);
                      setWorkDir("");
                      setInstall("");
                      setCommand("");
                      setPort("");
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

              <details className="text-sm" open={Boolean(setup) || Boolean(command)}>
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  {setup ? "Saved setup (edit for this preview only)" : "Command, install, port (optional — or we scan and ask)"}
                </summary>
                <div className="mt-3 flex flex-col gap-3">
                  <div className="grid grid-cols-2 gap-3">
                    <label className={FIELD} htmlFor={`${ids}-workdir`}>
                      <span className={LABEL}>Directory in repo</span>
                      <Input id={`${ids}-workdir`} value={workDir} onChange={(e) => setWorkDir(e.target.value)} placeholder="apps/web" className={MONO} />
                    </label>
                    <label className={FIELD} htmlFor={`${ids}-install`}>
                      <span className={LABEL}>Install (runs at repo root)</span>
                      <Input id={`${ids}-install`} value={install} onChange={(e) => setInstall(e.target.value)} placeholder="pnpm install" className={MONO} />
                    </label>
                  </div>
                  <label className={FIELD} htmlFor={`${ids}-command`}>
                    <span className={LABEL}>Command</span>
                    <Input id={`${ids}-command`} value={command} onChange={(e) => setCommand(e.target.value)} placeholder="pnpm run dev -H 0.0.0.0 -p 3000" className={MONO} />
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className={FIELD} htmlFor={`${ids}-port`}>
                      <span className={LABEL}>Port</span>
                      <Input id={`${ids}-port`} value={port} onChange={(e) => setPort(e.target.value)} placeholder="3000" inputMode="numeric" className={MONO} />
                    </label>
                    <label className={FIELD} htmlFor={`${ids}-label`}>
                      <span className={LABEL}>Label</span>
                      <Input id={`${ids}-label`} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={branch || "branch name"} />
                    </label>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input type="checkbox" checked={saveSetup} onChange={(e) => setSaveSetup(e.target.checked)} className="accent-foreground" />
                    {setup ? "Save changes to the project's setup" : "Save as this project's setup after launching"}
                  </label>
                  <label className={FIELD} htmlFor={`${ids}-env`}>
                    <span className={LABEL}>Env — KEY=VALUE lines ({setup ? "saved with the setup when checked below" : "values may use $&#123;PREVIEW_URL&#125; etc."})</span>
                    <textarea
                      id={`${ids}-env`}
                      value={envText}
                      onChange={(e) => setEnvText(e.target.value)}
                      rows={Math.min(8, Math.max(2, envText.split("\n").length))}
                      placeholder={"PAYLOAD_SECRET=…\nNEXT_PUBLIC_SERVER_URL=${PREVIEW_URL}"}
                      className={`${MONO} w-full rounded-md border border-input bg-transparent px-2.5 py-1.5 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50`}
                      autoComplete="off"
                      spellCheck={false}
                    />
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
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              <div className="flex flex-col gap-3">
                <label className={FIELD} htmlFor={`${ids}-d-command`}>
                  <span className={LABEL}>Command</span>
                  <Input id={`${ids}-d-command`} value={command} onChange={(e) => setCommand(e.target.value)} className={MONO} />
                </label>
                <div className="grid grid-cols-3 gap-3">
                  <label className={FIELD} htmlFor={`${ids}-d-dir`}>
                    <span className={LABEL}>Directory</span>
                    <Input id={`${ids}-d-dir`} value={workDir} onChange={(e) => setWorkDir(e.target.value)} className={MONO} />
                  </label>
                  <label className={FIELD} htmlFor={`${ids}-d-port`}>
                    <span className={LABEL}>Port</span>
                    <Input id={`${ids}-d-port`} value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" className={MONO} />
                  </label>
                  <label className={FIELD} htmlFor={`${ids}-d-label`}>
                    <span className={LABEL}>Label</span>
                    <Input id={`${ids}-d-label`} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={branch} />
                  </label>
                </div>
                <label className={FIELD} htmlFor={`${ids}-d-install`}>
                  <span className={LABEL}>Install (runs at repo root)</span>
                  <Input id={`${ids}-d-install`} value={install} onChange={(e) => setInstall(e.target.value)} className={MONO} />
                </label>
                <label className={FIELD} htmlFor={`${ids}-d-env`}>
                  <span className={LABEL}>Env — KEY=VALUE lines{saveSetup ? " (saved into the setup)" : ""}</span>
                  <textarea
                    id={`${ids}-d-env`}
                    value={envText}
                    onChange={(e) => setEnvText(e.target.value)}
                    rows={Math.min(8, Math.max(2, envText.split("\n").length))}
                    placeholder={"PAYLOAD_SECRET=…\nNEXT_PUBLIC_SERVER_URL=${PREVIEW_URL}"}
                    className={`${MONO} w-full rounded-md border border-input bg-transparent px-2.5 py-1.5 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50`}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" checked={saveSetup} onChange={(e) => setSaveSetup(e.target.checked)} className="accent-foreground" />
                  Save as this project&apos;s setup (next time is one click)
                </label>
              </div>
            </>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            {step === "form" ? (
              <Button type="submit" disabled={Boolean(busy) || !projectId || !repoId || !branch.trim()}>
                {busy === "create"
                  ? setup || command
                    ? "Provisioning, installing, launching…"
                    : "Provisioning & scanning…"
                  : setup
                    ? "Create preview"
                    : command
                      ? "Create preview"
                      : "Create & discover"}
              </Button>
            ) : (
              <Button type="button" disabled={busy !== null || !command.trim() || !install.trim() || !port.trim()} onClick={() => void confirm()}>
                {busy === "confirm" ? "Installing & launching…" : "Launch preview"}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
