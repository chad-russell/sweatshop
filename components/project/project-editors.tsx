"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FIELD, LABEL, MONO } from "@/components/form-styles";

/**
 * 0018 phase 3 / 0019 / 0031: the project page's editable surfaces —
 * name, sandbox image, repos (guarded removal), and the danger zone
 * (typed-name confirmed project delete, the approved cascade). Thin
 * clients over /api/projects/[id]/*; every error surfaces its message.
 */

interface Repo {
  id: string;
  name: string;
  url: string;
  host: string | null;
}

function useApi() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const call = async (run: () => Promise<Response>, onOk?: () => void) => {
    setBusy(true);
    setError(null);
    setNote(null);
    const res = await run();
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!res.ok) {
      setError(body.error ?? `failed (${res.status})`);
      return;
    }
    onOk?.();
  };
  return { busy, error, note, setNote, call };
}

/** The project's name — rename in place, under the page header. */
export function ProjectNameEditor({ projectId, name }: { projectId: string; name: string }) {
  const router = useRouter();
  const { busy, error, call } = useApi();
  const [value, setValue] = useState(name);

  const rename = () =>
    call(
      () =>
        fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: value }),
        }),
      () => router.refresh(),
    );

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Project name"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="max-w-72 text-base font-medium"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || !value.trim() || value.trim() === name}
          onClick={() => void rename()}
        >
          Rename
        </Button>
        <span className={`${MONO} text-muted-foreground`}>{projectId}</span>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

/** 0031: the project's sandbox image — one field, one button. Applies
 *  to the project's next sandbox (existing ones keep their image). */
export function ProjectImageEditor({
  projectId,
  imageRef,
}: {
  projectId: string;
  imageRef: string | null;
}) {
  const router = useRouter();
  const { busy, error, note, setNote, call } = useApi();
  const [value, setValue] = useState(imageRef ?? "");

  const save = () =>
    call(
      () =>
        fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ imageRef: value.trim() || null }),
        }),
      () => {
        setNote("Saved — applies to this project's next sandbox.");
        router.refresh();
      },
    );

  return (
    <div className="flex flex-col gap-2">
      <label className={FIELD} htmlFor="proj-image">
        <span className={LABEL}>Sandbox image</span>
        <div className="flex items-center gap-2">
          <Input
            id="proj-image"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setNote(null);
            }}
            placeholder="localhost/sweatshop-sandbox"
            className={`${MONO} max-w-96`}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || (value.trim() || null) === imageRef}
            onClick={() => void save()}
          >
            Save
          </Button>
        </div>
      </label>
      <p className="text-xs text-muted-foreground">
        Empty = the default image (built from Containerfile.sandbox).
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {note && <p className="text-sm text-muted-foreground">{note}</p>}
    </div>
  );
}

/** 0023: the project's work defaults — the verify-stage test command
 * and the machine branch prefix (both carried in stage briefs). */
export function ProjectWorkEditor({
  projectId,
  testCommand,
  branchPrefix,
}: {
  projectId: string;
  testCommand: string | null;
  branchPrefix: string | null;
}) {
  const router = useRouter();
  const { busy, error, note, setNote, call } = useApi();
  const [command, setCommand] = useState(testCommand ?? "");
  const [prefix, setPrefix] = useState(branchPrefix ?? "");

  const dirty = command.trim() !== (testCommand ?? "") || prefix.trim() !== (branchPrefix ?? "");
  const save = () =>
    call(
      () =>
        fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            testCommand: command.trim() || null,
            branchPrefix: prefix.trim() || null,
          }),
        }),
      () => {
        setNote("Saved — machine stages see it from the next run.");
        router.refresh();
      },
    );

  return (
    <div className="flex flex-col gap-2">
      <label className={FIELD} htmlFor="proj-test-command">
        <span className={LABEL}>Test command</span>
        <Input
          id="proj-test-command"
          value={command}
          onChange={(e) => {
            setCommand(e.target.value);
            setNote(null);
          }}
          placeholder="npm run typecheck && npm run test"
          className={`${MONO} max-w-96`}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        Run from a repo root; must exit 0. The create_pr approval card runs it — empty means the card falls back to the repo&rsquo;s own test script.
      </p>
      <label className={FIELD} htmlFor="proj-branch-prefix">
        <span className={LABEL}>Branch prefix</span>
        <Input
          id="proj-branch-prefix"
          value={prefix}
          onChange={(e) => {
            setPrefix(e.target.value);
            setNote(null);
          }}
          placeholder="eng"
          className={`${MONO} max-w-96`}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        Work branches land as &lt;prefix&gt;/&lt;slug&gt;; a ticket key in the task (e.g. ENG-1234) always wins. Empty = the generic &lt;type&gt;/&lt;slug&gt;.
      </p>
      <div>
        <Button type="button" size="sm" variant="outline" disabled={busy || !dirty} onClick={() => void save()}>
          Save
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {note && <p className="text-sm text-muted-foreground">{note}</p>}
    </div>
  );
}

export function ProjectReposEditor({ projectId, repos }: { projectId: string; repos: Repo[] }) {
  const router = useRouter();
  const { busy, error, note, setNote, call } = useApi();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);

  const add = () =>
    call(
      () =>
        fetch(`/api/projects/${encodeURIComponent(projectId)}/repos`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, url }),
        }),
      () => {
        setName("");
        setUrl("");
        setAdding(false);
        setNote("Repo added.");
        router.refresh();
      },
    );

  const remove = (repoId: string, repoName: string) =>
    call(
      () =>
        fetch(
          `/api/projects/${encodeURIComponent(projectId)}/repos?repoId=${encodeURIComponent(repoId)}`,
          { method: "DELETE" },
        ),
      () => {
        setNote(`Removed ${repoName}.`);
        router.refresh();
      },
    );

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {repos.map((repo) => (
          <li key={repo.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium">{repo.name}</span>
              <span className="flex flex-wrap items-center gap-x-2 font-mono text-xs text-muted-foreground">
                <span className="min-w-0 break-all">{repo.url}</span>
                <span aria-hidden>·</span>
                <span>{repo.host ? `${repo.host} credential` : "no credential"}</span>
              </span>
            </span>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => remove(repo.id, repo.name)}>
              Remove
            </Button>
          </li>
        ))}
        {repos.length === 0 && (
          <li className="px-3 py-2 text-sm text-muted-foreground">
            No repos — chats in this project run sandbox-less until one is added.
          </li>
        )}
      </ul>

      {adding ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <div className="grid grid-cols-[1fr_2fr] gap-3">
            <label className={FIELD} htmlFor="repo-name">
              <span className={LABEL}>Name (the clone directory)</span>
              <Input id="repo-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="open-bible" className={MONO} />
            </label>
            <label className={FIELD} htmlFor="repo-url">
              <span className={LABEL}>URL</span>
              <Input id="repo-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/org/repo" className={MONO} />
            </label>
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={busy || !name.trim() || !url.trim()} onClick={add}>
              Add repo
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button type="button" size="sm" variant="outline" onClick={() => setAdding(true)}>
            Add repo
          </Button>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      {note && <p className="text-sm text-muted-foreground">{note}</p>}
    </div>
  );
}

export function ProjectDangerZone({ projectId, name }: { projectId: string; name: string }) {
  const router = useRouter();
  const { busy, error, call } = useApi();
  const [typed, setTyped] = useState("");

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-destructive/40 p-3">
      <p className="text-sm text-muted-foreground">
        Deletes the project and everything it owns — conversations and their history (hard delete, no trash),
        conversations, previews and their sandboxes, folders, the preview setup, repos. Git
        credentials are untouched.
      </p>
      <label className={FIELD} htmlFor="danger-name">
        <span className={LABEL}>Type “{name}” to confirm</span>
        <Input id="danger-name" value={typed} onChange={(e) => setTyped(e.target.value)} className="max-w-72" autoComplete="off" />
      </label>
      <div>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={busy || typed !== name}
          onClick={() =>
            call(
              () => fetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }),
              () => {
                router.push("/");
                router.refresh();
              },
            )
          }
        >
          <Trash2 /> Delete project
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
