"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { diffLines } from "@/lib/plan";
import { parseModeSkill } from "@/lib/agent/mode-ids";

type Key = "base" | "harness_steering" | "host_routing";
type Target = { kind: "section"; key: Key } | { kind: "skill"; id: string };
type Row = { body: string; version: number; origin?: string; description?: string; thread?: boolean; mode?: boolean; status?: "active" | "disabled" | "deleted"; editedBy?: string; note?: string | null; updatedAt?: number; createdAt?: number };
type Listed = Row & Target;
type Default = { body: string; description?: string; thread?: boolean; mode?: boolean; status?: Row["status"] };
type Confirmation = { action: "reset" | "restore" | "publish"; version?: number; patch?: object; before: Row; after: Default; heading: string };
const SECTIONS = [
  { key: "base", name: "Base instructions", hint: "Every chat's top-level instructions" },
  { key: "harness_steering", name: "Harness steering", hint: "Included when the chat has a sandbox" },
  { key: "host_routing", name: "Host routing", hint: "Included when the project has hosts" },
] as const;
const EMPTY: Row = { body: "", version: 0, description: "", thread: false, mode: false, status: "active" };
const ID = /^[a-z][a-z0-9-]{0,40}$/;
const BOUNDARY = "This edits prompt text and the skill catalog's data. Tool access, approvals (create_pr, exec, project create/delete, and agent-proposed changes), and provider/model validation are enforced in code and cannot be changed here.";
const ENDPOINT = "/api/settings/agent";
function params(t: Target) { return `kind=${t.kind}&${t.kind === "section" ? `key=${t.key}` : `id=${encodeURIComponent(t.id)}`}`; }
async function request(url: string, init?: RequestInit) {
  const res = await fetch(url, { cache: "no-store", ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 409) throw new Error(data.issues?.join("; ") ?? data.error ?? `Request failed (${res.status})`);
  return data;
}
function title(body: string) { return body.match(/^# (.+)$/m)?.[1] ?? "Untitled"; }
function isDifferent(a: Default, b: Default, skill: boolean) {
  return a.body !== b.body || (skill && (a.description ?? "") !== (b.description ?? "")) || (skill && !!a.thread !== !!b.thread) || (skill && !!a.mode !== !!b.mode) || (skill && (a.status ?? "active") !== (b.status ?? "active"));
}
function Changes({ before, after, skill }: { before: Default; after: Default; skill: boolean }) {
  const fields = skill ? (["description", "thread", "mode", "status"] as const) : [];
  return <div className="space-y-2">
    {fields.filter(f => (before[f] ?? (f === "thread" || f === "mode" ? false : "")) !== (after[f] ?? (f === "thread" || f === "mode" ? false : ""))).map(f => <p key={f} className="rounded-md bg-muted px-2 py-1 text-xs"><strong>{f}</strong>: {String(before[f] ?? "")} → {String(after[f] ?? "")}</p>)}
    {before.body !== after.body ? <pre className="max-h-80 overflow-auto rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap">{diffLines(before.body, after.body).map((line, i) => <span key={i} className={`block ${line.op === "add" ? "bg-success/10 text-success" : line.op === "del" ? "bg-destructive/10 text-destructive" : ""}`}>{line.op === "add" ? "+ " : line.op === "del" ? "- " : "  "}{line.text}</span>)}</pre> : <p className="text-xs text-muted-foreground">Text is unchanged.</p>}
  </div>;
}

/** 0055 v7 part B: a live, derived read-only view of `parseModeSkill`
 *  over the draft body — the same parser that drives entry/advance, so
 *  what this shows is exactly what the mode will do, never a
 *  paraphrase. Client-safe: lib/agent/mode-ids.ts is pure. */
function ModePreview({ body }: { body: string }) {
  const parsed = parseModeSkill(body);
  const firstLine = parsed.brief.split("\n").find(l => l.trim())?.trim() ?? "";
  return <div className="space-y-1 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
    <p className="font-medium text-foreground">{parsed.phases.length > 0 ? `Mode: ${parsed.phases.map(p => p.name).join(" → ")}` : "No phases declared"}</p>
    <p>Shared: {parsed.shared ? "yes" : "no"}</p>
    <p>Brief: {parsed.brief.length} chars{firstLine ? ` · "${firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine}"` : ""}</p>
  </div>;
}

export function AgentSettings() {
  const [tab, setTab] = useState<"prompts" | "skills">("prompts");
  const [list, setList] = useState<Listed[]>([]);
  const [listDefaults, setListDefaults] = useState<Record<string, Default>>({});
  const [showDeleted, setShowDeleted] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  const [creating, setCreating] = useState(false);
  const [newId, setNewId] = useState("");
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
    try { const data = await request(`${ENDPOINT}?includeDeleted=${showDeleted}`); if (token !== listSequence.current) return; setList(data.targets); const defaults = await Promise.all((data.targets as Listed[]).map(async item => {
      if (item.kind === "skill" && item.origin !== "git") return null;
      try { return [item.kind === "section" ? item.key : item.id, await request(`${ENDPOINT}?action=default&${params(item)}`)] as const; } catch { return null; }
    })); if (token === listSequence.current) setListDefaults(Object.fromEntries(defaults.filter((entry): entry is readonly [string, Default] => entry !== null))); }
    catch (e) { if (token === listSequence.current) setError(String(e)); }
  }, [showDeleted]);
  useEffect(() => {
    // Start after the effect has returned; cleanup invalidates any in-flight reply.
    const sequenceForEffect = listSequence;
    const task = setTimeout(() => { void refreshList(); }, 0);
    return () => { clearTimeout(task); ++sequenceForEffect.current; };
  }, [refreshList]);
  const leave = () => { ++sequence.current; setTarget(null); setCreating(false); setConfirmation(null); setPreview(null); setError(""); setNotice(""); };
  const open = async (t: Target) => {
    const token = ++sequence.current;
    setTarget(t); setCreating(false); setCurrent(null); setDraft(EMPTY); setVersions([]); setShipped(null); setDefaultChecked(false); setCompare(false); setPreview(null); setConfirmation(null); setError(""); setNotice(""); setConflict(undefined);
    try {
      const detail = await request(`${ENDPOINT}?action=detail&${params(t)}`);
      if (token !== sequence.current) return;
      setCurrent(detail.current); setDraft(detail.current ?? EMPTY); setVersions(detail.versions ?? []);
      // The default endpoint is the only source of truth for git drift. Missing defaults disable Reset.
      try {
        const def = await request(`${ENDPOINT}?action=default&${params(t)}`);
        if (token === sequence.current) setShipped(def);
      } catch { /* A user-created skill, or a shipped file since removed. */ }
      if (token === sequence.current) setDefaultChecked(true);
    } catch (e) { if (token === sequence.current) setError(String(e)); }
  };
  const beginCreate = () => { ++sequence.current; setTab("skills"); setTarget(null); setCreating(true); setNewId(""); setCurrent(null); setDraft({ ...EMPTY }); setVersions([]); setShipped(null); setDefaultChecked(true); setPreview(null); setConfirmation(null); setError(""); setNotice(""); setConflict(undefined); };
  const selected: Target | null = creating ? ID.test(newId) ? { kind: "skill", id: newId } : null : target;
  const skill = creating || target?.kind === "skill";
  const dirty = current ? isDifferent(current, draft, !!skill) : creating && (draft.body !== "" || draft.description !== "" || !!draft.thread || !!draft.mode || draft.status !== "active");
  const execute = async (action: "publish" | "reset" | "restore", patch?: object, version?: number) => {
    if (!selected || busy) return;
    const token = sequence.current;
    setBusy(true); setError(""); setConflict(undefined); setConfirmation(null);
    try {
      const result = await request(ENDPOINT, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: selected, expectedVersion: current?.version ?? 0, action, patch, version }) });
      if (token !== sequence.current) return;
      if (!result.ok) {
        if (result.code === "conflict") { setConflict(result.current); setError("This target changed since it was loaded. Your draft is preserved. Review the latest version before retrying; nothing was overwritten."); }
        else setError(result.issues?.join("; ") ?? result.message ?? result.code ?? "Could not save.");
      } else {
        await open(selected);
        if (token + 1 === sequence.current) setNotice(`Saved as version ${result.version}.`);
        void refreshList();
      }
    } catch (e) { if (token === sequence.current) setError(String(e)); }
    finally { setBusy(false); }
  };
  const save = () => {
    if (creating && !ID.test(newId)) { setError("Use a skill id starting with a lowercase letter, followed by up to 40 lowercase letters, digits or hyphens."); return; }
    if (!selected) return;
    const patch = skill ? { body: draft.body, description: draft.description ?? "", thread: !!draft.thread, mode: !!draft.mode, status: draft.status ?? "active" } : { body: draft.body };
    if (skill && draft.status === "deleted" && current?.status !== "deleted") setConfirmation({ action: "publish", patch, before: current ?? EMPTY, after: draft, heading: "Delete skill from the catalog?" });
    else void execute("publish", patch);
  };
  const previewSequence = useRef(0);
  const showPreview = async () => {
    const token = sequence.current;
    const previewToken = ++previewSequence.current;
    const section = target?.kind === "section" ? target : null;
    const snapshot = draft.body;
    setError("");
    try {
      const data = await request(section ? ENDPOINT : `${ENDPOINT}?action=preview`, section ? {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "preview", target: section, body: snapshot }),
      } : undefined);
      if (token !== sequence.current || previewToken !== previewSequence.current) return;
      setPreview(data.prompt);
    } catch (e) {
      if (token === sequence.current && previewToken === previewSequence.current) {
        setPreview(null);
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  };
  const switchTab = (next: "prompts" | "skills") => { leave(); setTab(next); };
  return <section aria-labelledby="agent-settings-title" className="mt-10 space-y-5 border-t border-border pt-6">
    <h2 id="agent-settings-title" className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Agent settings</h2>
    <p className="text-sm text-muted-foreground">{BOUNDARY}</p>
    <div role="tablist" aria-label="Agent settings" className="flex gap-2 border-b border-border">
      {(["prompts", "skills"] as const).map(t => <button key={t} role="tab" type="button" id={`agent-tab-${t}`} aria-controls="agent-panel" aria-selected={tab === t} className={`rounded-t-lg px-4 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring ${tab === t ? "border-b-2 border-primary font-semibold text-foreground" : "text-muted-foreground hover:text-foreground"}`} onClick={() => switchTab(t)}>{t === "prompts" ? "Prompt sections" : "Skills"}</button>)}
    </div>
    <div role="tabpanel" id="agent-panel" aria-labelledby={`agent-tab-${tab}`} className="space-y-4">
      {!target && !creating && tab === "prompts" && <><p className="text-sm text-muted-foreground">Three independently editable blocks. Git updates never overwrite saved versions. A “Differs from shipped” label marks any difference from the current Git default. Use <code>{"{{owner}}"}</code> / <code>{"{{owner's}}"}</code> in body text for the owner&apos;s name — it renders at send time, so it stays correct if the owner ever changes.</p><div className="divide-y divide-border rounded-lg border border-border">{SECTIONS.map(s => { const item = list.find(x => x.kind === "section" && x.key === s.key); return <button key={s.key} type="button" className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring" onClick={() => void open({ kind: "section", key: s.key })}><span><strong className="text-sm">{s.name}</strong><small className="block text-muted-foreground">{s.hint}</small></span><span className="text-xs text-muted-foreground">{item && listDefaults[s.key] && isDifferent(item, listDefaults[s.key], false) ? "Differs from shipped · " : ""}v{item?.version ?? "…"} · Edit →</span></button>; })}</div><Button variant="outline" onClick={() => void showPreview()}>Preview saved assembled prompt</Button></>}
      {!target && !creating && tab === "skills" && <><div className="flex items-center justify-between gap-3"><p className="text-sm text-muted-foreground">Active and disabled skills. Deleted skills remain restorable in history.</p><Button onClick={beginCreate}>New skill</Button></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showDeleted} onChange={e => setShowDeleted(e.target.checked)} /> Show deleted</label><div className="divide-y divide-border rounded-lg border border-border">{list.filter(x => x.kind === "skill").map(x => <button key={x.id} type="button" onClick={() => void open({ kind: "skill", id: x.id })} className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring"><span><strong className="text-sm">{title(x.body)}</strong><small className="block font-mono text-muted-foreground">{x.id}</small></span><span className="text-xs text-muted-foreground">{x.thread ? "Thread · " : ""}{listDefaults[x.id] && isDifferent(x, listDefaults[x.id], true) ? "Differs from shipped · " : ""}{x.status} · v{x.version} →</span></button>)}</div></>}
      {(target || creating) && <div className="space-y-5"><Button size="sm" variant="ghost" onClick={leave}>← Back to {tab === "skills" ? "skills" : "prompt sections"}</Button><div className="space-y-4 rounded-lg border border-border p-4"><div className="flex flex-wrap items-center gap-2"><h3 className="text-base font-semibold">{creating ? "New skill" : target?.kind === "section" ? SECTIONS.find(s => s.key === target.key)?.name : `Skill: ${target?.id}`}</h3>{current && <span className="text-xs text-muted-foreground">v{current.version} · {current.editedBy}</span>}{current && defaultChecked && shipped && isDifferent(current, shipped, !!skill) && <span className="rounded-md bg-warning/10 px-2 py-0.5 text-xs text-warning">Differs from shipped default</span>}</div>
      {creating && <label className="block text-sm">Skill id <input aria-invalid={newId !== "" && !ID.test(newId)} className="mt-1 block w-full rounded-lg border border-border bg-background p-2 font-mono text-sm" value={newId} onChange={e => setNewId(e.target.value)} placeholder="my-skill" /><span className="text-xs text-muted-foreground">Lowercase letter first, then lowercase letters, digits or hyphens; at most 41 characters. This id cannot be renamed.</span></label>}
      {skill && <><p className="text-sm text-muted-foreground">Title (from the first # heading): {title(draft.body)}</p><label className="block text-sm">Description <input className="mt-1 block w-full rounded-lg border border-border bg-background p-2" maxLength={500} value={draft.description ?? ""} onChange={e => setDraft({ ...draft, description: e.target.value })} /></label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!draft.thread} onChange={e => setDraft({ ...draft, thread: e.target.checked })} /> Bindable to a new thread</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!draft.mode} onChange={e => setDraft({ ...draft, mode: e.target.checked, thread: e.target.checked ? true : draft.thread })} /> Mode (phased — see `## Phase: Name` headings)</label>{draft.mode && <ModePreview body={draft.body} />}<label className="block text-sm">Catalog status <select className="ml-2 rounded-lg border border-border bg-background p-2" value={draft.status ?? "active"} onChange={e => setDraft({ ...draft, status: e.target.value as Row["status"] })}><option value="active">Active</option><option value="disabled">Disabled</option><option value="deleted">Deleted</option></select></label><p className="text-xs text-muted-foreground">Disabled and deleted skills disappear from new selections. Threads already bound to a skill keep running with its current body, regardless of status. Deleted entries remain in history and can be restored.</p></>}
      <label className="block text-sm">{skill ? "Skill body (Markdown)" : "Instruction text"}<textarea className="mt-1 min-h-64 w-full rounded-lg border border-border bg-background p-3 font-mono text-sm" value={draft.body} onChange={e => { setDraft({ ...draft, body: e.target.value }); ++previewSequence.current; setPreview(null); }} /></label>
      <div className="flex flex-wrap gap-2"><Button disabled={busy || !selected || (!creating && !dirty)} onClick={save}>{busy ? "Saving…" : creating ? "Create skill" : "Save new version"}</Button>{!creating && current && <><Button variant="outline" onClick={() => setCompare(!compare)}>Compare shipped default</Button><Button variant="outline" disabled={busy || !shipped} onClick={() => shipped && setConfirmation({ action: "reset", before: current, after: { ...shipped, status: skill ? (shipped.status ?? "active") : undefined }, heading: "Reset to shipped default?" })}>Reset to shipped default</Button></>}{!skill && <Button variant="outline" onClick={() => void showPreview()}>Preview assembled prompt {dirty ? "with draft" : ""}</Button>}</div>
      {current && dirty && <details open className="space-y-2"><summary className="cursor-pointer text-sm font-medium">Unsaved changes · saved → draft</summary><Changes before={current} after={draft} skill={!!skill} /></details>}
      {creating && draft.body && <details><summary className="cursor-pointer text-sm font-medium">New skill preview</summary><Changes before={EMPTY} after={draft} skill /></details>}
      {compare && <div className="space-y-2"><h4 className="text-sm font-medium">Saved → current shipped default</h4>{shipped && current ? <Changes before={current} after={shipped} skill={!!skill} /> : <p className="text-sm text-muted-foreground">No shipped default is available for this skill.</p>}</div>}
      {current && <section aria-label="Version history" className="space-y-2"><h4 className="text-sm font-semibold">Version history</h4>{versions.map(v => <div key={v.version} className="rounded-lg border border-border p-3 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><span>v{v.version} · {v.editedBy ?? "unknown"} · {v.createdAt ? new Date(v.createdAt).toLocaleString() : ""}{v.note ? ` · ${v.note}` : ""}{skill ? ` · ${v.status}` : ""}</span><Button size="sm" variant="outline" disabled={busy || v.version === current.version} onClick={() => setConfirmation({ action: "restore", version: v.version, before: current, after: v, heading: `Restore version ${v.version}?` })}>Restore</Button></div><details className="mt-2"><summary className="cursor-pointer text-xs text-muted-foreground">Compare saved with v{v.version}</summary><Changes before={current} after={v} skill={!!skill} /></details></div>)}</section>}
      {conflict !== undefined && <div className="space-y-2 rounded-lg border border-destructive p-3"><p className="text-sm">Latest version: {conflict ? `v${conflict.version}` : "not found"}. Copy your draft before reloading.</p>{conflict && <details><summary className="cursor-pointer text-sm">Compare loaded version with latest</summary><Changes before={current ?? EMPTY} after={conflict} skill={!!skill} /></details>}<Button variant="outline" onClick={() => selected && void open(selected)}>Reload latest (discards draft)</Button></div>}
      </div></div>}
      {preview !== null && <div className="space-y-2"><h3 className="text-sm font-semibold">Assembled prompt · sample sandbox and host{target?.kind === "section" ? " · with your draft" : " · saved"}</h3><p className="text-xs text-muted-foreground">Repo instructions are read live from each repo, not editable here. Skill bindings are chosen per conversation; skill bodies are edited in Skills. Preview excludes those independently sourced regions.</p><pre className="max-h-96 overflow-auto rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap">{preview}</pre></div>}
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    <Dialog open={confirmation !== null} onOpenChange={open => { if (!open) setConfirmation(null); }}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>{confirmation?.heading}</DialogTitle><DialogDescription>This writes a new version; history remains available. Review the changes before confirming.</DialogDescription></DialogHeader>{confirmation && <Changes before={confirmation.before} after={confirmation.after} skill={!!skill} />}<DialogFooter><Button variant="outline" onClick={() => setConfirmation(null)}>Cancel</Button><Button disabled={busy} onClick={() => confirmation && void execute(confirmation.action, confirmation.patch, confirmation.version)}>Confirm new version</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}
