"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { LABEL, MONO } from "@/components/form-styles";
import {
  addGitCredential,
  listGitCredentials,
  updateGitCredentialSecret,
  type GitCredentialView,
} from "@/lib/api/git-credentials";

const INPUT = "h-8 w-full rounded-lg border border-border bg-background px-2 font-mono text-xs text-foreground";

/**
 * The `git_credentials` table, editable. Tokens are never shown whole —
 * only a start/end hint — and `.env.local` is NOT read for these, so
 * this is where a rotated token goes. New sandboxes pick it up; existing
 * ones keep their old token until re-provisioned.
 */
export function GitCredentials() {
  const [rows, setRows] = useState<GitCredentialView[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState("");
  const [username, setUsername] = useState("");
  const [kind, setKind] = useState<"github" | "forgejo">("github");
  const [baseUrl, setBaseUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void listGitCredentials()
      .then((res) => ("error" in res ? setError(res.error) : setRows(res.credentials)))
      .catch(() => setError("could not reach the server"));
  }, []);

  const close = () => {
    setEditing(null);
    setAdding(false);
    setSecret("");
    setUsername("");
    setBaseUrl("");
    setError(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = editing
        ? await updateGitCredentialSecret(editing, secret)
        : await addGitCredential({ kind, username, secret, baseUrl: kind === "forgejo" ? baseUrl : undefined });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setRows(res.credentials);
      setNotice("Saved. Start a new chat or re-provision the sandbox to use it.");
      close();
    } catch {
      setError("save failed — could not reach the server");
    } finally {
      setSaving(false);
    }
  };

  const form = (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-background px-3 py-2.5">
      {adding && (
        <>
          <select
            aria-label="Host"
            className={INPUT}
            value={kind}
            onChange={(e) => setKind(e.target.value as "github" | "forgejo")}
          >
            <option value="github">GitHub</option>
            <option value="forgejo">Forgejo</option>
          </select>
          <input
            aria-label="Username"
            className={INPUT}
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="username"
          />
          {kind === "forgejo" && (
            <input
              aria-label="Base URL"
              className={INPUT}
              spellCheck={false}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://git.example.com"
            />
          )}
        </>
      )}
      <input
        aria-label="Token"
        type="password"
        autoComplete="off"
        className={INPUT}
        spellCheck={false}
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        placeholder="paste the new token"
      />
      <span className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={saving || !secret.trim() || (adding && !username.trim())}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        <button type="button" className="text-muted-foreground underline underline-offset-2" onClick={close}>
          Cancel
        </button>
      </span>
    </div>
  );

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Git credentials</h2>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {rows?.length === 0 && <li className={`${LABEL} px-3 py-2.5`}>No credentials yet.</li>}
        {rows?.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-sm">
            <span className="flex-1 font-medium">
              {c.label}
              <span className={`${LABEL} ml-2`}>{c.baseUrl ?? "github.com"}</span>
            </span>
            <span className={`${MONO} text-muted-foreground`}>{c.hint}</span>
            {editing !== c.id && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  close();
                  setEditing(c.id);
                }}
              >
                Update token
              </Button>
            )}
            {editing === c.id && <div className="w-full">{form}</div>}
          </li>
        ))}
        <li className="flex flex-col gap-2 px-3 py-2.5 text-sm">
          {adding ? (
            form
          ) : (
            <button
              type="button"
              className="w-fit text-muted-foreground underline underline-offset-2"
              onClick={() => {
                close();
                setAdding(true);
              }}
            >
              Add a credential
            </button>
          )}
        </li>
      </ul>
      <span className={LABEL}>
        Used for sandbox clones, pushes and PRs. Not read from .env.local — change tokens here.
      </span>
      {notice && <span className={`${LABEL} text-success`}>{notice}</span>}
      {error && (
        <span role="alert" className={`${LABEL} text-destructive`}>
          {error}
        </span>
      )}
    </section>
  );
}
