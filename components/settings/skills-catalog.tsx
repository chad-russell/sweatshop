"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
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
import { SOURCES } from "@/lib/skills/sources";
import type { SkillOrigin, SearchResult } from "@/lib/skills/catalog-source";
import {
  installCatalogRequest,
  listCatalogRequest,
  previewCatalogRequest,
  searchCatalogRequest,
  type CatalogEntry,
  type CatalogPreview,
} from "@/lib/api/skills-catalog";

const INPUT = "h-8 w-full rounded-lg border border-border bg-background px-2 text-sm";
const SEGMENT =
  "h-8 rounded-lg border border-border px-3 text-sm data-[active=true]:bg-secondary data-[active=true]:text-secondary-foreground text-muted-foreground";

const kb = (n: number) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KiB`);

/** What the shared preview dialog is currently showing. */
interface PreviewTarget {
  origin: SkillOrigin;
  id: string;
  /** Where it comes from — the dialog's description line. */
  label: string;
}

/**
 * 0090 §4/§7 + 0091 §1: the catalog — the owner's skills and public
 * discovery in one place. "Yours" is the local list (0090 §4); "Find
 * skills" is SEARCH-first — SkillsMP queries the public banks, the
 * curated SOURCES stay browsable below it. Every install previews first
 * (the same trust surface as a save_skill approval) and writes with
 * provenance; SkillsMP itself is never a content source. Untrusted
 * bodies are data — rendered, never executed.
 */
export function SkillsCatalog({ skills }: { skills: SkillSummary[] }) {
  const [tab, setTab] = useState<"yours" | "find">("yours");
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
        <Button size="sm" variant="ghost" className={SEGMENT} data-active={tab === "find"} role="tab" aria-selected={tab === "find"} onClick={() => setTab("find")}>
          Find skills
        </Button>
      </div>

      {tab === "yours" ? (
        skills.length === 0 ? (
          <div className="rounded-lg border border-border p-4 text-sm">
            <p>Skills are agent runbooks saved in your skills store.</p>
            <p className="mt-1 text-muted-foreground">
              Ask any chat: <Link className="underline underline-offset-4" href="/?prompt=Write%20a%20skill%20for%20">write a skill for …</Link>{" "}
              — you approve every save — or{" "}
              <button type="button" className="underline underline-offset-4" onClick={() => setTab("find")}>
                find one in the public catalog
              </button>
              .
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
                      {(skill.invoke === "tool" || skill.invoke === "manual") && (
                        <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {skill.invoke}
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
        <FindPanel localIds={new Set(skills.map((s) => s.id))} />
      )}
    </section>
  );
}

/** Search-first discovery: SkillsMP results on top, curated sources
 * browsable below — one shared preview dialog and install path. */
function FindPanel({ localIds }: { localIds: Set<string> }) {
  const router = useRouter();

  // SkillsMP search state.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Curated-source browse state.
  const [sourceId, setSourceId] = useState<string>(SOURCES[0].id);
  const browseSource = SOURCES.find((s) => s.id === sourceId) ?? SOURCES[0];

  // Shared install + preview state.
  const [installing, setInstalling] = useState<string | null>(null);
  const [installed, setInstalled] = useState<string[]>([]);
  const [installError, setInstallError] = useState<string | null>(null);
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null);
  const [preview, setPreview] = useState<CatalogPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const isInstalled = (id: string) => localIds.has(id) || installed.includes(id);

  const runSearch = async (event: FormEvent) => {
    event.preventDefault();
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setSearchError(null);
    setResults(null);
    try {
      const res = await searchCatalogRequest(q);
      if ("error" in res) setSearchError(res.error);
      else if (!res.ok) setSearchError(res.message);
      else setResults(res.results);
    } catch {
      setSearchError("could not reach the server");
    } finally {
      setSearching(false);
    }
  };

  const openPreview = async (target: PreviewTarget) => {
    setPreviewTarget(target);
    setPreview(null);
    setPreviewError(null);
    setInstallError(null);
    const res = await previewCatalogRequest(target.id, target.origin);
    if ("error" in res) setPreviewError(res.error);
    else if (!res.ok) setPreviewError(res.message);
    else setPreview(res.skill);
  };

  const install = async (target: PreviewTarget) => {
    setInstalling(target.id);
    setInstallError(null);
    try {
      const res = await installCatalogRequest(target.id, target.origin);
      if ("error" in res) setInstallError(res.error);
      else if (!res.ok) setInstallError(res.message ?? "install failed");
      else {
        setInstalled((prev) => [...prev, target.id]);
        setPreviewTarget(null);
        router.refresh(); // "Yours" gains the skill
      }
    } catch {
      setInstallError("could not reach the server");
    } finally {
      setInstalling(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <form className="flex gap-2" onSubmit={runSearch}>
        <input
          aria-label="Search public skill banks"
          className={INPUT}
          placeholder="Search the public skill banks…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button type="submit" size="sm" variant="outline" disabled={searching || !query.trim()}>
          {searching ? "Searching…" : "Search"}
        </Button>
      </form>
      {searchError && <p role="alert" className="text-sm text-destructive">{searchError}</p>}
      {results !== null &&
        (results.length === 0 ? (
          <p className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
            No skills found for &quot;{query.trim()}&quot;.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Search results">
            {results.map((result) => (
              <li key={`${result.repo}|${result.path}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
                <button
                  type="button"
                  className={`${MONO} font-medium underline-offset-4 hover:underline`}
                  onClick={() =>
                    void openPreview({
                      origin: { origin: "search", repo: result.repo, path: result.path },
                      id: result.id,
                      label: `${result.repo} · ${result.path}`,
                    })
                  }
                >
                  {result.name}
                </button>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {result.author ? `${result.author} — ` : ""}
                  {result.description}
                </span>
                <span className={LABEL}>★ {result.stars}</span>
                {isInstalled(result.id) ? (
                  <span className={LABEL}>installed</span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={installing !== null}
                    onClick={() =>
                      void install({
                        origin: { origin: "search", repo: result.repo, path: result.path },
                        id: result.id,
                        label: `${result.repo} · ${result.path}`,
                      })
                    }
                  >
                    {installing === result.id ? "Installing…" : "Install"}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ))}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <span className={LABEL}>or browse</span>
        {SOURCES.map((s) => (
          <Button
            key={s.id}
            size="sm"
            variant="ghost"
            className={SEGMENT}
            data-active={sourceId === s.id}
            aria-pressed={sourceId === s.id}
            onClick={() => setSourceId(s.id)}
          >
            {s.label}
          </Button>
        ))}
      </div>
      <CatalogPanel
        key={browseSource.id}
        source={browseSource}
        installing={installing}
        isInstalled={isInstalled}
        onPreview={(id) =>
          void openPreview({ origin: { origin: "source", source: browseSource.id }, id, label: browseSource.label })
        }
        onInstall={(id) =>
          void install({ origin: { origin: "source", source: browseSource.id }, id, label: browseSource.label })
        }
      />
      {installError && (
        <p role="alert" className="text-sm text-destructive">
          {installError}
        </p>
      )}

      <Dialog
        open={previewTarget !== null}
        onOpenChange={(open) => {
          if (!open) setPreviewTarget(null);
        }}
      >
        <DialogContent className="max-h-(--radix-dialog-content-max-height) overflow-y-auto">
          {previewError ? (
            <p role="alert" className="text-sm text-destructive">{previewError}</p>
          ) : preview && previewTarget ? (
            <>
              <DialogHeader>
                <DialogTitle className={MONO}>{preview.id}</DialogTitle>
                <DialogDescription>
                  {previewTarget.label} · pinned {preview.sha.slice(0, 7)}
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
              {isInstalled(preview.id) ? (
                <p className={LABEL}>Installed — find it under Yours.</p>
              ) : (
                <Button size="sm" disabled={installing !== null} onClick={() => void install(previewTarget)}>
                  {installing === preview.id ? "Installing…" : "Install"}
                </Button>
              )}
            </>
          ) : (
            <p className={LABEL}>Loading…</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** One curated source's skills — the browse list under the search box
 * (0090 §7); preview and install ride FindPanel's shared paths. */
function CatalogPanel({
  source,
  installing,
  isInstalled,
  onPreview,
  onInstall,
}: {
  source: (typeof SOURCES)[number];
  installing: string | null;
  isInstalled: (id: string) => boolean;
  onPreview: (id: string) => void;
  onInstall: (id: string) => void;
}) {
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void listCatalogRequest(source.id)
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
  }, [source.id]);

  if (error) return <p role="alert" className="rounded-lg border border-border p-4 text-sm text-destructive">{error}</p>;
  if (entries === null) return <p className={LABEL}>Loading {source.label}…</p>;
  if (entries.length === 0) {
    return <p className="rounded-lg border border-border p-4 text-sm text-muted-foreground">No skills found in {source.label}.</p>;
  }

  return (
    <>
      {truncated && <p className={LABEL}>Showing the first {entries.length} skills — the source holds more.</p>}
      <ul className="divide-y divide-border rounded-lg border border-border">
        {entries.map((entry) => (
          <li key={entry.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
            <button type="button" className={`${MONO} font-medium underline-offset-4 hover:underline`} onClick={() => onPreview(entry.id)}>
              {entry.id}
            </button>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{entry.description}</span>
            <span className={LABEL}>
              {entry.fileCount} file{entry.fileCount === 1 ? "" : "s"} · {kb(entry.sizeBytes)}
            </span>
            {isInstalled(entry.id) ? (
              <span className={LABEL}>installed</span>
            ) : (
              <Button size="sm" variant="outline" disabled={installing !== null} onClick={() => onInstall(entry.id)}>
                {installing === entry.id ? "Installing…" : "Install"}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
