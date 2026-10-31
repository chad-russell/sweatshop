"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { LocalTime } from "@/components/local-time";
import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LABEL, MONO } from "@/components/form-styles";
import { parseSkillMarkdown, type SkillSummary } from "@/lib/skills/store";
import {
  installCatalogRequest,
  listCatalogRequest,
  previewCatalogRequest,
  type CatalogEntry,
  type CatalogPreview,
} from "@/lib/api/skills-catalog";

const INPUT = "h-8 w-full rounded-lg border border-border bg-background px-2 text-sm";
const SEGMENT =
  "h-8 rounded-lg border border-border px-3 text-sm data-[active=true]:bg-secondary data-[active=true]:text-secondary-foreground text-muted-foreground";
/** v1's single source label — static here so lib/skills/catalog-source
 * (a server module) never lands in the client bundle. */
const SOURCE_LABEL = "anthropics/skills";

const kb = (n: number) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KiB`);

/**
 * 0090 §4/§7: the catalog — the owner's skills and public sources in one
 * place. "Yours" is the local list (0090 §4); a source tab (v1:
 * anthropics/skills) lists the repo's skills, previews before install
 * (the same trust surface as a save_skill approval), and installs with
 * provenance. Untrusted bodies are data — rendered, never executed.
 */
export function SkillsCatalog({ skills }: { skills: SkillSummary[] }) {
  const [tab, setTab] = useState<"yours" | "source">("yours");
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q
    ? skills.filter((s) => s.id.includes(q) || s.description.toLowerCase().includes(q))
    : skills;

  return (
    <section aria-labelledby="skills-catalog-title" className="flex flex-col gap-2">
      <h2 id="skills-catalog-title" className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Skills
      </h2>
      <div className="flex gap-2" role="tablist" aria-label="Skill source">
        <Button size="sm" variant="ghost" className={SEGMENT} data-active={tab === "yours"} role="tab" aria-selected={tab === "yours"} onClick={() => setTab("yours")}>
          Yours
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className={SEGMENT}
          data-active={tab === "source"}
          role="tab"
          aria-selected={tab === "source"}
          onClick={() => setTab("source")}
        >
          {SOURCE_LABEL}
        </Button>
      </div>

      {tab === "yours" ? (
        skills.length === 0 ? (
          <div className="rounded-lg border border-border p-4 text-sm">
            <p>Skills are agent runbooks saved in your skills store.</p>
            <p className="mt-1 text-muted-foreground">
              Ask any chat: <Link className="underline underline-offset-4" href="/?prompt=Write%20a%20skill%20for%20">write a skill for …</Link>{" "}
              — you approve every save — or browse {SOURCE_LABEL} above.
            </p>
          </div>
        ) : (
          <>
            <input
              aria-label="Filter skills"
              className={INPUT}
              placeholder="Filter by id or description…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <p className={LABEL}>
              {shown.length} of {skills.length} shown
            </p>
            {shown.length === 0 ? (
              <p className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
                No skills match &quot;{query.trim()}&quot;.
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {shown.map((skill) => (
                  <li key={skill.id}>
                    <Link
                      href={`/settings/skills/${skill.id}`}
                      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2.5 text-sm hover:bg-muted/50"
                    >
                      <span className={`${MONO} font-medium`}>{skill.id}</span>
                      {skill.disabled && (
                        <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          disabled
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">{skill.description}</span>
                      <span className={LABEL}>
                        {skill.files.length} file{skill.files.length === 1 ? "" : "s"}
                      </span>
                      <LocalTime className={LABEL} ms={Date.parse(skill.updatedAt)} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </>
        )
      ) : (
        <CatalogPanel localIds={new Set(skills.map((s) => s.id))} />
      )}
    </section>
  );
}

/** One public source's skills: list, preview dialog, install (0090 §7). */
function CatalogPanel({ localIds }: { localIds: Set<string> }) {
  const router = useRouter();
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<CatalogPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installed, setInstalled] = useState<string[]>([]);
  const [installError, setInstallError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void listCatalogRequest()
      .then((res) => {
        if (!live) return;
        if ("error" in res || !res.ok) setError("error" in res ? res.error : res.message);
        else {
          setEntries(res.skills);
          setTruncated(res.truncated);
        }
      })
      .catch(() => live && setError("could not reach the server"));
    return () => {
      live = false;
    };
  }, []);

  const openPreview = async (id: string) => {
    setPreview(null);
    setPreviewError(null);
    setInstallError(null);
    const res = await previewCatalogRequest(id);
    if ("error" in res) setPreviewError(res.error);
    else if (!res.ok) setPreviewError(res.message);
    else setPreview(res.skill);
  };

  const install = async (id: string) => {
    setInstalling(id);
    setInstallError(null);
    try {
      const res = await installCatalogRequest(id);
      if ("error" in res) setInstallError(res.error);
      else if (!res.ok) setInstallError(res.message ?? "install failed");
      else {
        setInstalled((prev) => [...prev, id]);
        router.refresh(); // "Yours" gains the skill
      }
    } catch {
      setInstallError("could not reach the server");
    } finally {
      setInstalling(null);
    }
  };

  if (error) return <p role="alert" className="rounded-lg border border-border p-4 text-sm text-destructive">{error}</p>;
  if (entries === null) return <p className={LABEL}>Loading the catalog…</p>;
  if (entries.length === 0) {
    return <p className="rounded-lg border border-border p-4 text-sm text-muted-foreground">No skills found in this source.</p>;
  }

  return (
    <>
      {truncated && <p className={LABEL}>Showing the first {entries.length} skills — the source holds more.</p>}
      <ul className="divide-y divide-border rounded-lg border border-border">
        {entries.map((entry) => {
          const isInstalled = localIds.has(entry.id) || installed.includes(entry.id);
          return (
            <li key={entry.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
              <button type="button" className={`${MONO} font-medium underline-offset-4 hover:underline`} onClick={() => void openPreview(entry.id)}>
                {entry.id}
              </button>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{entry.description}</span>
              <span className={LABEL}>
                {entry.fileCount} file{entry.fileCount === 1 ? "" : "s"} · {kb(entry.sizeBytes)}
              </span>
              {isInstalled ? (
                <span className={LABEL}>installed</span>
              ) : (
                <Button size="sm" variant="outline" disabled={installing !== null} onClick={() => void install(entry.id)}>
                  {installing === entry.id ? "Installing…" : "Install"}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {installError && (
        <p role="alert" className="text-sm text-destructive">
          {installError}
        </p>
      )}

      <Dialog
        open={preview !== null || previewError !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPreview(null);
            setPreviewError(null);
          }
        }}
      >
        <DialogContent className="max-h-(--radix-dialog-content-max-height) overflow-y-auto">
          {previewError ? (
            <p role="alert" className="text-sm text-destructive">{previewError}</p>
          ) : preview ? (
            <>
              <DialogHeader>
                <DialogTitle className={MONO}>{preview.id}</DialogTitle>
                <DialogDescription>
                  {SOURCE_LABEL} · pinned {preview.sha.slice(0, 7)}
                </DialogDescription>
              </DialogHeader>
              <MessageResponse className="text-sm">{parseSkillMarkdown(preview.raw).body}</MessageResponse>
              {preview.files.length > 0 && (
                <ul className={LABEL}>
                  {preview.files.map((file) => (
                    <li key={file.path}>
                      <span className={MONO}>{file.path}</span> · {kb(file.size)}
                    </li>
                  ))}
                </ul>
              )}
              {localIds.has(preview.id) || installed.includes(preview.id) ? (
                <p className={LABEL}>Installed — find it under Yours.</p>
              ) : (
                <Button
                  size="sm"
                  disabled={installing !== null}
                  onClick={() => void install(preview.id).then(() => setPreview(null))}
                >
                  {installing === preview.id ? "Installing…" : "Install"}
                </Button>
              )}
            </>
          ) : (
            <p className={LABEL}>Loading…</p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
