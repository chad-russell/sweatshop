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
import { sourceById, type CatalogSourceId, type SourceDef } from "@/lib/skills/sources";

/**
 * 0090 §7 + 0091 §1: public catalog discovery — a catalog source is a
 * git repo of skill folders, browsed with the GitHub git-trees API (ONE
 * call, recursive) with descriptions fetched from raw.githubusercontent
 * at the PINNED sha (immutable, so a preview and its install always read
 * the same bytes). Everything is value-shaped and never throws; the
 * assembled listing is cached 10 minutes per source. Untrusted content
 * is data only — rendered, never executed; install is a store write.
 *
 * The sources themselves live in lib/skills/sources.ts (client-safe).
 */

export type { CatalogSourceId, SourceDef };

const LIST_TTL_MS = 10 * 60_000;
/** v1 cap: descriptions cost one raw fetch each; past this the list truncates. */
const MAX_LISTED = 30;
const TIMEOUT_MS = 10_000;

const source = sourceById;

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
    if (!res.ok) return { ok: false, message: `${res.status} for ${url}` };
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

// ---- federated search (0091 §1) ---------------------------------------------

/** One SkillsMP row mapped to an install target. SkillsMP is a
 * directory, never a content source — content still comes from GitHub
 * at a pinned sha. */
export interface SearchResult {
  /** The skill folder's name — the install id. */
  id: string;
  name: string;
  author: string;
  description: string;
  stars: number;
  repo: string;
  path: string;
  ref: string;
}

export type CatalogSearch =
  | { ok: true; results: SearchResult[] }
  | { ok: false; message: string };

const SEARCH_TTL_MS = 5 * 60_000;
const searchCache = new Map<string, { at: number; result: CatalogSearch }>();

interface SkillsMpEnvelope {
  data?: { skills?: Record<string, unknown>[] };
}

/** github.com/<owner>/<repo>/(tree|blob)/<ref>/<path> — the path points
 * at the skill folder itself (SKILL.md-suffixed links tolerated). */
const GITHUB_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:tree|blob)\/([^/]+)\/(.+)$/;

function searchResultFromRow(row: Record<string, unknown>): SearchResult | null {
  const m = typeof row.githubUrl === "string" ? GITHUB_URL.exec(row.githubUrl) : null;
  if (!m) return null;
  const [, owner, repo, ref, rawPath] = m;
  const path = rawPath.replace(/\/+$/, "").replace(/\/SKILL\.md$/, "");
  const id = path.slice(path.lastIndexOf("/") + 1);
  if (!SKILL_ID.test(id)) return null;
  return {
    id,
    name: typeof row.name === "string" && row.name ? row.name : id,
    author: typeof row.author === "string" ? row.author : "",
    description: typeof row.description === "string" ? row.description : "",
    stars: typeof row.stars === "number" ? row.stars : 0,
    repo: `${owner}/${repo}`,
    path,
    ref,
  };
}

/** SkillsMP search across the public skill banks — pages 1-2 in
 * parallel (40 rows), githubUrl parsed into owner/repo/ref/path,
 * unparseable rows skipped, cached 5 min per query. No custom
 * User-Agent: the API 403s browser-shaped requests. */
export async function searchCatalogs(query: string, opts?: { fetchImpl?: FetchImpl }): Promise<CatalogSearch> {
  const q = query.trim();
  if (!q) return { ok: false, message: "empty query" };
  const cacheKey = q.toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SEARCH_TTL_MS) return cached.result;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const url = (page: number) => `https://skillsmp.com/api/v1/skills/search?q=${encodeURIComponent(q)}&page=${page}`;
  const [p1, p2] = await Promise.all([1, 2].map((page) => fetchJson<SkillsMpEnvelope>(url(page), {}, fetchImpl)));
  if (!p1.ok && !p2.ok) return { ok: false, message: p1.message };
  const rows = [...(p1.ok ? p1.value.data?.skills ?? [] : []), ...(p2.ok ? p2.value.data?.skills ?? [] : [])];
  const byTarget = new Map<string, SearchResult>();
  for (const row of rows) {
    const result = searchResultFromRow(row);
    if (result && !byTarget.has(`${result.repo}|${result.path}`)) byTarget.set(`${result.repo}|${result.path}`, result);
  }
  const result: CatalogSearch = { ok: true, results: [...byTarget.values()] };
  searchCache.set(cacheKey, { at: Date.now(), result });
  return result;
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
  searchCache.clear();
  branchCache.clear();
}

async function loadTree(def: SourceDef, fetchImpl: FetchImpl): Promise<TreeCache | { error: string }> {
  const cached = treeCache.get(def.id);
  if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached;
  const headers = githubHeaders();
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

// ---- one skill: preview + install (0090 §7 + 0091 §1) -----------------------

/** owner/repo — the search-origin install target. */
export const REPO_SHAPE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Where a preview/install comes from: a curated SOURCES entry, or a
 * SkillsMP search hit pointing at any public repo folder. */
export type SkillOrigin =
  | { origin: "source"; source: string }
  | { origin: "search"; repo: string; path: string };

export type ParsedOrigin = { ok: true; value: SkillOrigin } | { ok: false; message: string };

/** Route-side parsing of the origin params/body — shape errors only;
 * anything about the remote is a value from the call itself. */
export function parseSkillOrigin(input: { origin?: unknown; source?: unknown; repo?: unknown; path?: unknown }): ParsedOrigin {
  if (input.origin === undefined || input.origin === "source") {
    if (input.source !== undefined && typeof input.source !== "string") return { ok: false, message: "source must be a string" };
    const sourceId = typeof input.source === "string" && input.source ? input.source : "anthropics";
    if (!sourceById(sourceId)) return { ok: false, message: `unknown catalog source "${sourceId}"` };
    return { ok: true, value: { origin: "source", source: sourceId } };
  }
  if (input.origin === "search") {
    if (typeof input.repo !== "string" || !REPO_SHAPE.test(input.repo)) {
      return { ok: false, message: "origin=search requires repo as owner/repo" };
    }
    if (typeof input.path !== "string" || !validFilePath(input.path)) {
      return { ok: false, message: "origin=search requires a valid repo-relative folder path" };
    }
    return { ok: true, value: { origin: "search", repo: input.repo, path: input.path } };
  }
  return { ok: false, message: `unknown origin "${String(input.origin)}"` };
}

/** Metadata limits checked BEFORE any content fetch. */
function limitIssue(skillMdSize: number, files: { path: string; size: number }[]): string | null {
  const supporting = files.filter((f) => f.path !== "SKILL.md" && f.path !== "manifest.json" && validFilePath(f.path));
  if (supporting.length + 1 > MAX_FILES) return `catalog skill has ${supporting.length + 1} files (max ${MAX_FILES})`;
  const total = skillMdSize + supporting.reduce((sum, f) => sum + f.size, 0);
  if (skillMdSize > MAX_FILE_BYTES || supporting.some((f) => f.size > MAX_FILE_BYTES)) {
    return `catalog skill has a file above ${MAX_FILE_BYTES / 1024} KiB`;
  }
  if (total > MAX_SKILL_BYTES) return `catalog skill exceeds ${MAX_SKILL_BYTES / 1024} KiB in total`;
  return null;
}

/** Read one repo folder's files at a pinned ref — the shared core the
 * SOURCES browse path and search-origin installs both ride. The skill
 * id IS the folder's last path segment. */
async function readRepoFolder(
  {
    owner,
    repo,
    ref,
    folderPath,
    skillMdSize,
    files,
  }: {
    owner: string;
    repo: string;
    ref: string;
    folderPath: string;
    skillMdSize: number;
    files: { path: string; size: number }[];
  },
  fetchImpl: FetchImpl,
): Promise<CatalogRead> {
  const issue = limitIssue(skillMdSize, files);
  if (issue) return { ok: false, code: "invalid", message: issue };
  const supporting = files.filter((f) => f.path !== "SKILL.md" && f.path !== "manifest.json" && validFilePath(f.path));
  const base = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${folderPath}`;
  const reads = await Promise.all([
    fetchText(`${base}/SKILL.md`, fetchImpl),
    ...supporting.map((f) => fetchText(`${base}/${f.path}`, fetchImpl)),
  ]);
  const texts: string[] = [];
  for (const read of reads) {
    if (!read.ok) return { ok: false, code: "catalog-error", message: read.message };
    texts.push(read.text);
  }
  return {
    ok: true,
    skill: {
      id: folderPath.slice(folderPath.lastIndexOf("/") + 1),
      raw: texts[0],
      files: supporting.map((f, i) => ({ path: f.path, content: texts[i + 1] })),
      sha: ref,
    },
  };
}

/** The SOURCES path: folder lookup inside a cached source tree. */
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
  return readRepoFolder(
    { owner: def.owner, repo: def.repo, ref: tree.sha, folderPath: folder.folderPath, skillMdSize: folder.skillMdSize, files: folder.files },
    fetchImpl,
  );
}

const branchCache = new Map<string, { at: number; branch: string }>();

function githubHeaders(): Record<string, string> {
  const token = githubToken();
  return { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

async function defaultBranch(
  owner: string,
  repo: string,
  fetchImpl: FetchImpl,
): Promise<{ ok: true; branch: string } | { ok: false; message: string }> {
  const key = `${owner}/${repo}`;
  const cached = branchCache.get(key);
  if (cached && Date.now() - cached.at < LIST_TTL_MS) return { ok: true, branch: cached.branch };
  const res = await fetchJson<{ default_branch: string }>(`https://api.github.com/repos/${owner}/${repo}`, githubHeaders(), fetchImpl);
  if (!res.ok) return { ok: false, message: res.message };
  branchCache.set(key, { at: Date.now(), branch: res.value.default_branch });
  return { ok: true, branch: res.value.default_branch };
}

/** The search path: resolve the repo's default branch, pin its CURRENT
 * head sha (a branch NAME is not immutable — installs record the sha),
 * then read the tree AT that sha so preview and install see one
 * coherent snapshot. */
async function readSearchSkill(repo: string, folderPath: string, fetchImpl: FetchImpl): Promise<CatalogRead> {
  if (!REPO_SHAPE.test(repo)) return { ok: false, code: "invalid", message: `invalid repo "${repo}" (expected owner/repo)` };
  if (!validFilePath(folderPath)) return { ok: false, code: "invalid", message: `invalid path "${folderPath}"` };
  const id = folderPath.slice(folderPath.lastIndexOf("/") + 1);
  if (!SKILL_ID.test(id)) return { ok: false, code: "invalid", message: "skill id must match ^[a-z][a-z0-9-]{0,40}$" };
  const [owner, repoName] = repo.split("/") as [string, string];
  const branch = await defaultBranch(owner, repoName, fetchImpl);
  if (!branch.ok) return { ok: false, code: "catalog-error", message: branch.message };
  const head = await fetchJson<{ sha: string }>(
    `https://api.github.com/repos/${owner}/${repoName}/commits/${encodeURIComponent(branch.branch)}`,
    githubHeaders(),
    fetchImpl,
  );
  if (!head.ok) return { ok: false, code: "catalog-error", message: head.message };
  const sha = head.value.sha;
  const tree = await fetchJson<{ tree: { path: string; type: string; size?: number }[] }>(
    `https://api.github.com/repos/${owner}/${repoName}/git/trees/${encodeURIComponent(sha)}?recursive=1`,
    githubHeaders(),
    fetchImpl,
  );
  if (!tree.ok) return { ok: false, code: "catalog-error", message: tree.message };
  const files = tree.value.tree
    .filter((entry) => entry.type === "blob" && entry.path.startsWith(`${folderPath}/`))
    .map((entry) => ({ path: entry.path.slice(folderPath.length + 1), size: entry.size ?? 0 }));
  const skillMd = files.find((f) => f.path === "SKILL.md");
  if (!skillMd) return { ok: false, code: "unknown-skill", message: `No SKILL.md at ${repo}/${folderPath}.` };
  return readRepoFolder({ owner, repo: repoName, ref: sha, folderPath, skillMdSize: skillMd.size, files }, fetchImpl);
}

/** The preview surface: every file, contents included. */
export async function previewCatalogSkill(
  sourceId: string,
  skillId: string,
  opts?: { fetchImpl?: FetchImpl },
): Promise<CatalogRead> {
  return readCatalogSkill(sourceId, skillId, opts?.fetchImpl ?? fetch);
}

/** Search-origin preview — any public repo folder (0091 §1). */
export async function previewSearchSkill(
  repo: string,
  path: string,
  opts?: { fetchImpl?: FetchImpl },
): Promise<CatalogRead> {
  return readSearchSkill(repo, path, opts?.fetchImpl ?? fetch);
}

/** Strip the front matter's `name:` line — our id IS the folder; keep
 * description and any status. */
function normalizeFrontMatter(raw: string): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!front) return raw;
  const header = front[1].replace(/^name:.*\r?\n?/m, "");
  return raw.replace(front[0], () => `---\n${header}\n---\n`);
}

/** Validate and write one read into the store with provenance — the
 * shared install tail. */
async function writeInstall(
  skillId: string,
  read: CatalogSkill,
  source: { repo: string; ref: string; path: string },
  author: string,
): Promise<InstallResult> {
  const body = normalizeFrontMatter(read.raw);
  const issues = validateSkillInput({ id: skillId, body, files: read.files });
  if (issues.length > 0) return { ok: false, code: "invalid", message: issues.join("; ") };
  return saveSkill({ id: skillId, body, files: read.files, author, source });
}

const idExists = (skillId: string): InstallResult => ({
  ok: false,
  code: "id-exists",
  message: `A local skill "${skillId}" already exists. Disable or rename it (ask the agent) before installing.`,
});

/** Read at the pinned ref, validate, write into the store with source
 * provenance. A colliding local id is an honest error — rename or
 * disable it via the agent first. */
export async function installCatalogSkill(
  sourceId: string,
  skillId: string,
  opts?: { author?: string; fetchImpl?: FetchImpl },
): Promise<InstallResult> {
  const def = source(sourceId);
  if (!def) return { ok: false, code: "catalog-error", message: `unknown catalog source "${sourceId}"` };
  if (await readSkill(skillId)) return idExists(skillId);
  const read = await readCatalogSkill(sourceId, skillId, opts?.fetchImpl ?? fetch);
  if (!read.ok) return read;
  return writeInstall(skillId, read.skill, { repo: `${def.owner}/${def.repo}`, ref: read.skill.sha, path: `${def.path}/${skillId}` }, opts?.author ?? "catalog");
}

/** Search-origin install (0091 §1): the id is the folder's name; the
 * ref pinned is the repo's CURRENT head sha at install time; the
 * default author marks the SkillsMP directory as the discovery path. */
export async function installSearchSkill(
  repo: string,
  path: string,
  opts?: { author?: string; fetchImpl?: FetchImpl },
): Promise<InstallResult> {
  const id = path.slice(path.lastIndexOf("/") + 1);
  if (!SKILL_ID.test(id)) return { ok: false, code: "invalid", message: "skill id must match ^[a-z][a-z0-9-]{0,40}$" };
  if (await readSkill(id)) return idExists(id);
  const read = await readSearchSkill(repo, path, opts?.fetchImpl ?? fetch);
  if (!read.ok) return read;
  return writeInstall(id, read.skill, { repo, ref: read.skill.sha, path }, opts?.author ?? "skillsmp");
}
