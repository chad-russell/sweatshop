"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
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
import { NativeSelect } from "@/components/ui/native-select";
import { FIELD, LABEL, MONO } from "@/components/form-styles";
import { SetupFields } from "@/components/project/setup-editor";
import { useNewPreview } from "@/components/previews/use-new-preview";

/**
 * 0017/0019: the New-preview dialog — markup only; the flow's state is
 * `useNewPreview`. Project (hidden when `projects` has one entry — the
 * project page and a scoped /previews pass just theirs) → repo →
 * branch, then Create. With the project's saved setup it shows a
 * one-line summary (the setup is edited on the project page only) and
 * provisions + launches in one shot. With NO setup yet this is the
 * first-fill moment: it provisions, SCANS the checkout (Discover), you
 * pick/edit a candidate in the setup editor, and confirming saves that
 * as the project's setup. Provisioning failures are visible rows on
 * /previews, never silent 500s.
 */

export function NewPreviewForm({ projects }: { projects: { id: string; name: string }[] }) {
  const f = useNewPreview(projects);
  const {
    ids, open, close, step, busy, error, projectId, repos, repoId, branches, branchWarning, branch,
    label, hasSetup, setupRepoId, values, candidates, picked, launchable,
  } = f;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={projects.length === 0} title={projects.length === 0 ? "No project has a repo yet" : undefined}>
          <Plus /> New preview
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={(e) => void f.submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{step === "discover" ? "Pick what to preview" : "New branch preview"}</DialogTitle>
            <DialogDescription>
              {step === "discover"
                ? "Scanned the checkout — pick a package; edit and launch. This saves as the project's setup."
                : "A dedicated sandbox serves the branch and redeploys every time it moves. Failures land in your Inbox."}
            </DialogDescription>
          </DialogHeader>

          {step === "form" ? (
            <>
              <div className={projects.length > 1 ? "grid grid-cols-2 gap-3" : "grid grid-cols-1 gap-3"}>
                {projects.length > 1 && (
                  <label className={FIELD} htmlFor={`${ids}-project`}>
                    <span className={LABEL}>Project</span>
                    <NativeSelect
                      id={`${ids}-project`}
                      value={projectId}
                      onChange={(e) => f.chooseProject(e.target.value)}
                    >
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                )}
                <label className={FIELD} htmlFor={`${ids}-repo`}>
                  <span className={LABEL}>Repo</span>
                  <NativeSelect
                    id={`${ids}-repo`}
                    value={repoId}
                    disabled={repos.length === 0}
                    onChange={(e) => f.chooseRepo(e.target.value)}
                  >
                    {repos.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </NativeSelect>
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
                  onChange={(e) => f.setBranch(e.target.value)}
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

              {hasSetup ? (
                <div className="flex flex-col gap-1 rounded-md border border-input px-3 py-2 text-sm">
                  <span className={LABEL}>Project setup</span>
                  <span className={MONO}>
                    {values.command} · :{values.port}
                    {values.services.length ? ` · ${values.services.length} service${values.services.length > 1 ? "s" : ""}` : ""}
                  </span>
                  {setupRepoId && repoId && setupRepoId !== repoId && (
                    <span className="text-xs text-muted-foreground">
                      The setup is for {repos.find((r) => r.id === setupRepoId)?.name ?? "another repo"}; this preview
                      uses its values anyway.
                    </span>
                  )}
                  <Link
                    href={`/p/${encodeURIComponent(projectId)}`}
                    className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    Edit on the project page →
                  </Link>
                </div>
              ) : (
                <details className="text-sm" open={Boolean(values.command)}>
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    Command, install, port… (optional — or we scan and ask). Saves as the project&apos;s setup.
                  </summary>
                  <div className="mt-3 flex flex-col gap-3">
                    <SetupFields ids={ids} values={values} onChange={f.setValues} />
                  </div>
                </details>
              )}
              <label className={FIELD} htmlFor={`${ids}-label`}>
                <span className={LABEL}>Label (this preview only)</span>
                <Input id={`${ids}-label`} value={label} onChange={(e) => f.setLabel(e.target.value)} placeholder={branch || "branch name"} />
              </label>
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
                    <input type="radio" name="candidate" checked={i === picked} onChange={() => f.applyCandidate(i)} className="mt-1 accent-foreground" />
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
                <SetupFields ids={ids} values={values} onChange={f.setValues} />
                <label className={FIELD} htmlFor={`${ids}-d-label`}>
                  <span className={LABEL}>Label (this preview only)</span>
                  <Input id={`${ids}-d-label`} value={label} onChange={(e) => f.setLabel(e.target.value)} placeholder={branch} />
                </label>
              </div>
            </>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            {step === "form" ? (
              <Button type="submit" disabled={Boolean(busy) || !projectId || !repoId || !branch.trim()}>
                {busy === "create"
                  ? launchable
                    ? "Provisioning, installing, launching…"
                    : "Provisioning & scanning…"
                  : hasSetup || launchable
                    ? "Create preview"
                    : "Create & discover"}
              </Button>
            ) : (
              <Button type="button" disabled={busy !== null || !launchable} onClick={() => void f.confirm()}>
                {busy === "confirm" ? "Installing & launching…" : "Launch preview"}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
