import { db } from "@/db";
import { listGitCredentials } from "@/db/projects";
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_SKILL_BYTES,
  SKILL_ID,
  parseSkillMarkdown,
  readSkill,
  saveSkill,
  validateSkillInput,
  validFilePath,
  type StoreResult,
} from "@/lib/skills/store";

/**
 * 0090 §7: public catalog discovery — a catalog source is a git repo of
 * skill folders, browsed with the GitHub git-trees API (ONE call,
 * recursive) with descriptions fetched from raw.githubusercontent.com at
 * the PINNED sha (immutable, so a preview and its install always read
 * the same bytes). Everything is value-shaped and never throws; the
 * assembled listing is cached 10 minutes per source. Untrusted content
 * is data only — rendered, never executed; install is a store write.
 */

export type CatalogSourceId = "anthropics";

interface SourceDef {
  id: CatalogSourceId;
  owner: string;
  repo: string;
  /** The repo-relative folder holding the skill folders. */
  path: string;
  label: string;
}

export const SOURCES: readonly SourceDef[] = [
  { id: "anthropics", owner: "anthropics", repo: "skills", path: "skills", label: "anthropics/skills" },
];

const LIST_TTL_MS = 10 * 60_000;
/** v1 cap: descriptions cost one raw fetch each; past this the list truncates. */
const MAX_LISTED = 30;
const TIMEOUT_MS = 10_000;

const source = (id: string): SourceDef | undefined => SOURCES.find((s) => s.id === id);

export interface CatalogEntry {
  id: string;
  description: string;
  /** SKILL.md included. */
  fileCount: number;
  sizeBytes: number;
}

export type CatalogList =
  | { ok: true; skills: CatalogEntry[]; truncated: boolean }
  | { ok: false; message: string };

export interface CatalogSkill {
  id: string;
  raw: string;
  files: { path: string; content: string }[];
  /** The commit everything was read at — the install's pinned ref. */
  sha: string;
}

export type CatalogRead =
  | { ok: true; skill: CatalogSkill }
  | { ok: false; code: "unknown-skill" | "invalid" | "catalog-error"; message: string };

export type InstallResult =
  | StoreResult<{ id: string; files: string[] }>
  | { ok: false; code: "id-exists" | "catalog-error"; message: string };

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The STORED github credential raises api.github.com's rate limit; the
 * public repo works without one. Raw fetches stay unauthenticated. */
function githubToken(): string | undefined {
  return listGitCredentials(db()).find((c) => c.kind === "github")?.secret;
}

async function fetchJson<T>(url: string, headers: Record<string, string>, fetchImpl: FetchImpl): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ok: false, message: `GitHub ${res.status} for ${url}` };
    return { ok: true, value: (await res.json()) as T };
  } catch (err) {
    return { ok: false, message: message(err) };
  }
}

async function fetchText(url: string, fetchImpl: FetchImpl): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status} for ${url}` };
    return { ok: true, text: await res.text() };
  } catch (err) {
    return { ok: false, message: message(err) };
  }
}


/** Public catalogs use full YAML (folded `>`/`|-` scalars, multi-line
 * blocks) while our own store writes single-line descriptions. Parse the
 * common shapes for DISPLAY: a folded/block scalar joins its indented
 * continuation lines; a plain scalar keeps today's single line. */
export function catalogDescription(raw: string): string {
  const parsed = parseSkillMarkdown(raw);
  if (parsed.description && parsed.description !== ">" && parsed.description !== "|") return parsed.description;
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  const header = front?.[1] ?? "";
  const m = /^description:\s*(>|\|)(-)?\s*\r?\n((?:[ \t]+.*(?:\r?\n|$))+)/m.exec(header);
  if (!m) return parsed.description;
  const joiner = m[1] === ">" ? " " : "\n";
  const text = m[3]
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => line.trim())
    .join(joiner)
    .trim();
  return text.length > 500 ? text.slice(0, 499).trimEnd() + "…" : text;
}

// ---- the tree (one call, cached) ------------------------------------------

interface TreeFolder {
  id: string;
  /** Repo-relative folder path (the manifest's `path`). */
  folderPath: string;
  files: { path: string; size: number }[];
  skillMdSize: number;
}

interface TreeCache {
  at: number;
  sha: string;
  folders: TreeFolder[];
}

const treeCache = new Map<string, TreeCache>();
const listCache = new Map<string, { at: number; result: CatalogList }>();

/** Tests only: drop the caches so a fresh fetchImpl is actually read. */
export function __resetCatalogCacheForTests(): void {
  treeCache.clear();
  listCache.clear();
}

async function loadTree(def: SourceDef, fetchImpl: FetchImpl): Promise<TreeCache | { error: string }> {
  const cached = treeCache.get(def.id);
  if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached;
  const headers = { accept: "application/vnd.github+json", ...(githubToken() ? { authorization: `Bearer ${githubToken()}` } : {}) };
  const repo = await fetchJson<{ default_branch: string }>(`https://api.github.com/repos/${def.owner}/${def.repo}`, headers, fetchImpl);
  if (!repo.ok) return { error: repo.message };
  const sha = repo.value.default_branch;
  const tree = await fetchJson<{ tree: { path: string; type: string; size?: number }[] }>(
    `https://api.github.com/repos/${def.owner}/${def.repo}/git/trees/${encodeURIComponent(sha)}?recursive=1`,
    headers,
    fetchImpl,
  );
  if (!tree.ok) return { error: tree.message };
  const byFolder = new Map<string, { files: { path: string; size: number }[] }>();
  for (const entry of tree.value.tree) {
    if (entry.type !== "blob") continue;
    const rest = entry.path.startsWith(`${def.path}/`) ? entry.path.slice(def.path.length + 1) : null;
    if (rest === null) continue;
    const slash = rest.indexOf("/");
    if (slash < 1) continue; // a file directly under path/, not in a skill folder
    const folder = rest.slice(0, slash);
    const bucket = byFolder.get(folder) ?? { files: [] };
    bucket.files.push({ path: rest.slice(slash + 1), size: entry.size ?? 0 });
    byFolder.set(folder, bucket);
  }
  const folders: TreeFolder[] = [];
  for (const [id, { files }] of byFolder) {
    const skillMd = files.find((file) => file.path === "SKILL.md");
    if (!skillMd || !SKILL_ID.test(id)) continue;
    folders.push({ id, folderPath: `${def.path}/${id}`, files, skillMdSize: skillMd.size });
  }
  folders.sort((a, b) => a.id.localeCompare(b.id));
  const fresh: TreeCache = { at: Date.now(), sha, folders };
  treeCache.set(def.id, fresh);
  return fresh;
}

// ---- the list ----------------------------------------------------------------

/** Every skill in a source, descriptions included. At most MAX_LISTED
 * entries (each costs one raw SKILL.md fetch) — `truncated` says when
 * the repo holds more. */
export async function listCatalog(
  sourceId: string,
  opts?: { fetchImpl?: FetchImpl },
): Promise<CatalogList> {
  const def = source(sourceId);
  if (!def) return { ok: false, message: `unknown catalog source "${sourceId}"` };
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const cached = listCache.get(def.id);
  if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached.result;

  const tree = await loadTree(def, fetchImpl);
  if ("error" in tree) return { ok: false, message: tree.error };

  const listed = tree.folders.slice(0, MAX_LISTED);
  const raws = await Promise.all(
    listed.map((folder) =>
      fetchText(`https://raw.githubusercontent.com/${def.owner}/${def.repo}/${tree.sha}/${folder.folderPath}/SKILL.md`, fetchImpl),
    ),
  );
  const skills: CatalogEntry[] = [];
  for (const [i, folder] of listed.entries()) {
    const raw = raws[i];
    if (!raw.ok) continue; // unreadable SKILL.md → not a skill we can offer
    const description = catalogDescription(raw.text);
    if (!description) continue;
    skills.push({
      id: folder.id,
      description,
      fileCount: folder.files.length,
      sizeBytes: folder.files.reduce((total, file) => total + file.size, 0),
    });
  }
  const result: CatalogList = { ok: true, skills, truncated: tree.folders.length > MAX_LISTED };
  listCache.set(def.id, { at: Date.now(), result });
  return result;
}

// ---- one skill: preview + install ------------------------------------------

async function readCatalogSkill(
  sourceId: string,
  skillId: string,
  fetchImpl: FetchImpl,
): Promise<CatalogRead> {
  const def = source(sourceId);
  if (!def) return { ok: false, code: "catalog-error", message: `unknown catalog source "${sourceId}"` };
  if (!SKILL_ID.test(skillId)) return { ok: false, code: "invalid", message: "skill id must match ^[a-z][a-z0-9-]{0,40}$" };
  const tree = await loadTree(def, fetchImpl);
  if ("error" in tree) return { ok: false, code: "catalog-error", message: tree.error };
  const folder = tree.folders.find((f) => f.id === skillId);
  if (!folder) return { ok: false, code: "unknown-skill", message: `No skill "${skillId}" in ${def.label}.` };

  // Limits checked against tree metadata BEFORE any content fetch.
  const supporting = folder.files.filter((file) => file.path !== "SKILL.md" && file.path !== "manifest.json" && validFilePath(file.path));
  if (supporting.length + 1 > MAX_FILES) {
    return { ok: false, code: "invalid", message: `catalog skill has ${supporting.length + 1} files (max ${MAX_FILES})` };
  }
  const skillMdSize = folder.skillMdSize;
  const total = skillMdSize + supporting.reduce((sum, file) => sum + file.size, 0);
  if (skillMdSize > MAX_FILE_BYTES || supporting.some((file) => file.size > MAX_FILE_BYTES)) {
    return { ok: false, code: "invalid", message: `catalog skill has a file above ${MAX_FILE_BYTES / 1024} KiB` };
  }
  if (total > MAX_SKILL_BYTES) {
    return { ok: false, code: "invalid", message: `catalog skill exceeds ${MAX_SKILL_BYTES / 1024} KiB in total` };
  }

  const base = `https://raw.githubusercontent.com/${def.owner}/${def.repo}/${tree.sha}/${folder.folderPath}`;
  const reads = await Promise.all([
    fetchText(`${base}/SKILL.md`, fetchImpl),
    ...supporting.map((file) => fetchText(`${base}/${file.path}`, fetchImpl)),
  ]);
  const texts: string[] = [];
  for (const read of reads) {
    if (!read.ok) return { ok: false, code: "catalog-error", message: read.message };
    texts.push(read.text);
  }
  return {
    ok: true,
    skill: {
      id: skillId,
      raw: texts[0],
      files: supporting.map((file, i) => ({ path: file.path, content: texts[i + 1] })),
      sha: tree.sha,
    },
  };
}

/** The preview surface: every file, contents included. */
export async function previewCatalogSkill(
  sourceId: string,
  skillId: string,
  opts?: { fetchImpl?: FetchImpl },
): Promise<CatalogRead> {
  return readCatalogSkill(sourceId, skillId, opts?.fetchImpl ?? fetch);
}

/** Strip the front matter's `name:` line — our id IS the folder; keep
 * description and any status. */
function normalizeFrontMatter(raw: string): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!front) return raw;
  const header = front[1].replace(/^name:.*\r?\n?/m, "");
  return raw.replace(front[0], () => `---\n${header}\n---\n`);
}

/** Read at the pinned sha, validate, write into the store with source
 * provenance. A colliding local id is an honest error — rename or
 * disable it via the agent first. */
export async function installCatalogSkill(
  sourceId: string,
  skillId: string,
  opts?: { author?: string; fetchImpl?: FetchImpl },
): Promise<InstallResult> {
  const def = source(sourceId);
  if (!def) return { ok: false, code: "catalog-error", message: `unknown catalog source "${sourceId}"` };
  if (await readSkill(skillId)) {
    return {
      ok: false,
      code: "id-exists",
      message: `A local skill "${skillId}" already exists. Disable or rename it (ask the agent) before installing.`,
    };
  }
  const read = await readCatalogSkill(sourceId, skillId, opts?.fetchImpl ?? fetch);
  if (!read.ok) return read;
  const body = normalizeFrontMatter(read.skill.raw);
  const issues = validateSkillInput({ id: skillId, body, files: read.skill.files });
  if (issues.length > 0) return { ok: false, code: "invalid", message: issues.join("; ") };
  return saveSkill({
    id: skillId,
    body,
    files: read.skill.files,
    author: opts?.author ?? "catalog",
    source: { repo: `${def.owner}/${def.repo}`, ref: read.skill.sha, path: `${def.path}/${skillId}` },
  });
}
