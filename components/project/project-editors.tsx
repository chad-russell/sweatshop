"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { FIELD, LABEL, MONO } from "@/components/form-styles";

/**
 * 0018 phase 3 / 0019: the project page's editable surfaces — name,
 * sandbox config, repos (guarded removal), and the danger zone
 * (typed-name confirmed project delete, the approved cascade). Thin
 * clients over /api/projects/[id]/*; every error surfaces its message.
 */

interface Repo {
  id: string;
  name: string;
  url: string;
  host: string | null;
}

interface Config {
  id: string;
  imageRef: string | null;
  networkPolicy: string;
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

/** The project's sandbox config: pick one, and edit the SHARED config
 *  (image, network policy) — other projects may run it too. */
export function ProjectSandboxEditor({
  projectId,
  config,
  configOptions,
  sharedWith,
}: {
  projectId: string;
  config: Config | null;
  configOptions: { id: string; name?: string }[];
  sharedWith: number;
}) {
  const router = useRouter();
  const { busy, error, note, setNote, call } = useApi();
  const [configId, setConfigId] = useState(config?.id ?? "");
  const [imageRef, setImageRef] = useState(config?.imageRef ?? "");
  const [networkPolicy, setNetworkPolicy] = useState(config?.networkPolicy ?? "allow-all");

  const save = () =>
    call(
      () =>
        fetch(`/api/projects/${encodeURIComponent(projectId)}/sandbox-config`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            configId: configId || null,
            ...(configId ? { imageRef, networkPolicy } : {}),
          }),
        }),
      () => {
        setNote("Saved — applies to this project's next sandbox.");
        router.refresh();
      },
    );

  return (
    <div className="flex flex-col gap-3">
      <label className={FIELD} htmlFor="proj-config">
        <span className={LABEL}>Sandbox config</span>
        <NativeSelect
          id="proj-config"
          value={configId}
          onChange={(e) => {
            setConfigId(e.target.value);
            setNote(null);
          }}
          className="max-w-72"
        >
          <option value="">none — default image, sandbox per chat</option>
          {configOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name ?? c.id}
            </option>
          ))}
        </NativeSelect>
      </label>

      {configId && (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">
            Shared config{sharedWith > 1 ? ` — ${sharedWith} projects run it; edits change all of them` : ""}.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <label className={FIELD} htmlFor="proj-image">
              <span className={LABEL}>Image ref</span>
              <Input id="proj-image" value={imageRef} onChange={(e) => setImageRef(e.target.value)} placeholder="localhost/sweatshop-sandbox" className={MONO} />
            </label>
            <label className={FIELD} htmlFor="proj-network">
              <span className={LABEL}>Network policy (recorded, not enforced)</span>
              <NativeSelect
                id="proj-network"
                value={networkPolicy}
                onChange={(e) => setNetworkPolicy(e.target.value)}
              >
                <option value="allow-all">allow-all</option>
                <option value="offline">offline</option>
              </NativeSelect>
            </label>
          </div>
          <div>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={save}>
              Save config
            </Button>
          </div>
        </div>
      )}

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
        machine runs, previews and their sandboxes, folders, the preview setup, repos. Machines, sandbox configs,
        and git credentials are untouched.
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
