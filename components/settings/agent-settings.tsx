"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { diffLines } from "@/lib/text-diff";
import {
  getAgentDefault,
  getAgentDetail,
  getAssembledPrompt,
  listAgentTargets,
  previewSectionDraft,
  putAgentTarget,
  type AgentDefault,
  type AgentTarget,
  type ListedTarget,
  type Row,
} from "@/lib/api/agent-settings";

type Target = AgentTarget;
type Listed = ListedTarget;
type Default = AgentDefault;
type Confirmation = { action: "reset" | "restore" | "publish"; version?: number; patch?: object; before: Row; after: Default; heading: string };
const SECTIONS = [
  { key: "base", name: "Base instructions", hint: "Every chat's top-level instructions" },
  { key: "harness_steering", name: "Harness steering", hint: "Included when the chat has a sandbox" },
  { key: "host_routing", name: "Host routing", hint: "Included when the project has hosts" },
] as const;
const EMPTY: Row = { body: "", version: 0 };
const BOUNDARY = "This edits prompt text. Tool access, approvals (create_pr, exec, project create/delete, and agent-proposed changes), and provider/model validation are enforced in code and cannot be changed here.";
function isDifferent(a: Default, b: Default) { return a.body !== b.body; }
function Changes({ before, after }: { before: Default; after: Default }) {
  return before.body !== after.body ? <pre className="max-h-80 overflow-auto rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap">{diffLines(before.body, after.body).map((line, i) => <span key={i} className={`block ${line.op === "add" ? "bg-success/10 text-success" : line.op === "del" ? "bg-destructive/10 text-destructive" : ""}`}>{line.op === "add" ? "+ " : line.op === "del" ? "- " : "  "}{line.text}</span>)}</pre> : <p className="text-xs text-muted-foreground">Text is unchanged.</p>;
}

export function AgentSettings() {
  const [list, setList] = useState<Listed[]>([]);
  const [listDefaults, setListDefaults] = useState<Record<string, Default>>({});
  const [target, setTarget] = useState<Target | null>(null);
  const [current, setCurrent] = useState<Row | null>(null);
  const [draft, setDraft] = useState<Row>(EMPTY);
  const [versions, setVersions] = useState<Row[]>([]);
  const [shipped, setShipped] = useState<Default | null>(null);
  const [defaultChecked, setDefaultChecked] = useState(false);
  const [compare, setCompare] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState<Row | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const listSequence = useRef(0);
  const refreshList = useCallback(async () => {
    const token = ++listSequence.current;
    try { const data = await listAgentTargets(); if (token !== listSequence.current) return; setList(data.targets); const defaults = await Promise.all(data.targets.map(async (item): Promise<readonly [string, Default] | null> => {
      if (item.kind !== "section") return null;
      try { return [item.key, await getAgentDefault(item)] as const; } catch { return null; }
    })); if (token === listSequence.current) setListDefaults(Object.fromEntries(defaults.filter((entry): entry is readonly [string, Default] => entry !== null))); }
    catch (e) { if (token === listSequence.current) setError(String(e)); }
  }, []);
  useEffect(() => {
    // Start after the effect has returned; cleanup invalidates any in-flight reply.
    const sequenceForEffect = listSequence;
    const task = setTimeout(() => { void refreshList(); }, 0);
    return () => { clearTimeout(task); ++sequenceForEffect.current; };
  }, [refreshList]);
  const leave = () => { ++sequence.current; setTarget(null); setConfirmation(null); setPreview(null); setError(""); setNotice(""); };
  const open = async (t: Target) => {
    const token = ++sequence.current;
    setTarget(t); setCurrent(null); setDraft(EMPTY); setVersions([]); setShipped(null); setDefaultChecked(false); setCompare(false); setPreview(null); setConfirmation(null); setError(""); setNotice(""); setConflict(undefined);
    try {
      const detail = await getAgentDetail(t);
      if (token !== sequence.current) return;
      setCurrent(detail.current); setDraft(detail.current ?? EMPTY); setVersions(detail.versions ?? []);
      // The default endpoint is the only source of truth for git drift. Missing defaults disable Reset.
      try {
        const def = await getAgentDefault(t);
        if (token === sequence.current) setShipped(def);
      } catch { /* A shipped file since removed. */ }
      if (token === sequence.current) setDefaultChecked(true);
    } catch (e) { if (token === sequence.current) setError(String(e)); }
  };
  const selected: Target | null = target;
  const dirty = current ? isDifferent(current, draft) : false;
  const execute = async (action: "publish" | "reset" | "restore", patch?: object, version?: number) => {
    if (!selected || busy) return;
    const token = sequence.current;
    setBusy(true); setError(""); setConflict(undefined); setConfirmation(null);
    try {
      const result = await putAgentTarget({ target: selected, expectedVersion: current?.version ?? 0, action, patch, version });
      if (token !== sequence.current) return;
      if (!result.ok) {
        if (result.code === "conflict") { setConflict(result.current ?? null); setError("This target changed since it was loaded. Your draft is preserved. Review the latest version before retrying; nothing was overwritten."); }
        else setError(result.issues?.join("; ") ?? result.code ?? "Could not save.");
      } else {
        await open(selected);
        if (token + 1 === sequence.current) setNotice(`Saved as version ${result.version}.`);
        void refreshList();
      }
    } catch (e) { if (token === sequence.current) setError(String(e)); }
    finally { setBusy(false); }
  };
  const save = () => { if (selected) void execute("publish", { body: draft.body }); };
  const previewSequence = useRef(0);
  const showPreview = async () => {
    const token = sequence.current;
    const previewToken = ++previewSequence.current;
    const section = target?.kind === "section" ? target : null;
    const snapshot = draft.body;
    setError("");
    try {
      const data = section ? await previewSectionDraft(section.key, snapshot) : await getAssembledPrompt();
      if (token !== sequence.current || previewToken !== previewSequence.current) return;
      setPreview(data.prompt);
    } catch (e) {
      if (token === sequence.current && previewToken === previewSequence.current) {
        setPreview(null);
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  };
  return <section aria-labelledby="agent-settings-title" className="space-y-5">
    <h2 id="agent-settings-title" className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Agent settings</h2>
    <p className="text-sm text-muted-foreground">{BOUNDARY}</p>
    <div className="space-y-4">
      {!target && <><p className="text-sm text-muted-foreground">Three independently editable blocks. Git updates never overwrite saved versions. A “Differs from shipped” label marks any difference from the current Git default. Use <code>{"{{owner}}"}</code> / <code>{"{{owner's}}"}</code> in body text for the owner&apos;s name — it renders at send time, so it stays correct if the owner ever changes.</p><div className="divide-y divide-border rounded-lg border border-border">{SECTIONS.map(s => { const item = list.find(x => x.kind === "section" && x.key === s.key); return <button key={s.key} type="button" className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring" onClick={() => void open({ kind: "section", key: s.key })}><span><strong className="text-sm">{s.name}</strong><small className="block text-muted-foreground">{s.hint}</small></span><span className="text-xs text-muted-foreground">{item && listDefaults[s.key] && isDifferent(item, listDefaults[s.key]) ? "Differs from shipped · " : ""}v{item?.version ?? "…"} · Edit →</span></button>; })}</div><Button variant="outline" onClick={() => void showPreview()}>Preview saved assembled prompt</Button></>}
      {target && <div className="space-y-5"><Button size="sm" variant="ghost" onClick={leave}>← Back to prompt sections</Button><div className="space-y-4 rounded-lg border border-border p-4"><div className="flex flex-wrap items-center gap-2"><h3 className="text-base font-semibold">{target.kind === "section" ? SECTIONS.find(s => s.key === target.key)?.name : null}</h3>{current && <span className="text-xs text-muted-foreground">v{current.version} · {current.editedBy}</span>}{current && defaultChecked && shipped && isDifferent(current, shipped) && <span className="rounded-md bg-warning/10 px-2 py-0.5 text-xs text-warning">Differs from shipped default</span>}</div>
      <label className="block text-sm">Instruction text<textarea className="mt-1 min-h-64 w-full rounded-lg border border-border bg-background p-3 font-mono text-sm" value={draft.body} onChange={e => { setDraft({ ...draft, body: e.target.value }); ++previewSequence.current; setPreview(null); }} /></label>
      <div className="flex flex-wrap gap-2"><Button disabled={busy || !selected || !dirty} onClick={save}>{busy ? "Saving…" : "Save new version"}</Button>{current && <><Button variant="outline" onClick={() => setCompare(!compare)}>Compare shipped default</Button><Button variant="outline" disabled={busy || !shipped} onClick={() => shipped && setConfirmation({ action: "reset", before: current, after: shipped, heading: "Reset to shipped default?" })}>Reset to shipped default</Button></>}<Button variant="outline" onClick={() => void showPreview()}>Preview assembled prompt {dirty ? "with draft" : ""}</Button></div>
      {current && dirty && <details open className="space-y-2"><summary className="cursor-pointer text-sm font-medium">Unsaved changes · saved → draft</summary><Changes before={current} after={draft} /></details>}
      {compare && <div className="space-y-2"><h4 className="text-sm font-medium">Saved → current shipped default</h4>{shipped && current ? <Changes before={current} after={shipped} /> : <p className="text-sm text-muted-foreground">No shipped default is available.</p>}</div>}
      {current && <section aria-label="Version history" className="space-y-2"><h4 className="text-sm font-semibold">Version history</h4>{versions.map(v => <div key={v.version} className="rounded-lg border border-border p-3 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><span>v{v.version} · {v.editedBy ?? "unknown"} · {v.createdAt ? new Date(v.createdAt).toLocaleString() : ""}{v.note ? ` · ${v.note}` : ""}</span><Button size="sm" variant="outline" disabled={busy || v.version === current.version} onClick={() => setConfirmation({ action: "restore", version: v.version, before: current, after: v, heading: `Restore version ${v.version}?` })}>Restore</Button></div><details className="mt-2"><summary className="cursor-pointer text-xs text-muted-foreground">Compare saved with v{v.version}</summary><Changes before={current} after={v} /></details></div>)}</section>}
      {conflict !== undefined && <div className="space-y-2 rounded-lg border border-destructive p-3"><p className="text-sm">Latest version: {conflict ? `v${conflict.version}` : "not found"}. Copy your draft before reloading.</p>{conflict && <details><summary className="cursor-pointer text-sm">Compare loaded version with latest</summary><Changes before={current ?? EMPTY} after={conflict} /></details>}<Button variant="outline" onClick={() => selected && void open(selected)}>Reload latest (discards draft)</Button></div>}
      </div></div>}
      {preview !== null && <div className="space-y-2"><h3 className="text-sm font-semibold">Assembled prompt · sample sandbox and host{target?.kind === "section" ? " · with your draft" : " · saved"}</h3><p className="text-xs text-muted-foreground">Repo instructions are read live from each repo, not editable here. Preview excludes those independently sourced regions.</p><pre className="max-h-96 overflow-auto rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap">{preview}</pre></div>}
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    <Dialog open={confirmation !== null} onOpenChange={open => { if (!open) setConfirmation(null); }}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>{confirmation?.heading}</DialogTitle><DialogDescription>This writes a new version; history remains available. Review the changes before confirming.</DialogDescription></DialogHeader>{confirmation && <Changes before={confirmation.before} after={confirmation.after} />}<DialogFooter><Button variant="outline" onClick={() => setConfirmation(null)}>Cancel</Button><Button disabled={busy} onClick={() => confirmation && void execute(confirmation.action, confirmation.patch, confirmation.version)}>Confirm new version</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}
