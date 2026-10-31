import { z } from "zod";

/**
 * 0088: the dynamic skills catalog — an S3-compatible bucket (rustfs) is
 * the source of truth. The ONLY module that touches @aws-sdk/client-s3
 * (dynamic import inside `s3Gateway`); everything else reads through the
 * functions below, and tests inject a fake `S3Gateway` instead of a network.
 *
 * Layout: `<prefix><id>/SKILL.md` + sibling files + `<id>/manifest.json`,
 * written LAST. Store errors are values, never throws into a turn: an
 * unreachable or unconfigured store reads as an empty catalog plus a
 * status for the Settings card.
 */

export const SKILL_ID = /^[a-z][a-z0-9-]{0,40}$/;
export const MAX_FILES = 16;
export const MAX_FILE_BYTES = 64 * 1024;
export const MAX_SKILL_BYTES = 256 * 1024;
export const MAX_DESCRIPTION_CHARS = 500;
const SKILL_FILE = "SKILL.md";
const MANIFEST_FILE = "manifest.json";
const LISTING_TTL_MS = 60_000;
/** A failed listing is retried sooner than a good one expires. */
const ERROR_TTL_MS = 10_000;
const LRU_SKILLS = 32;

/** The thin bucket seam: all the store needs from S3. */
export interface S3Gateway {
  /** Every object under the (already normalized) prefix, paginated away. */
  list(prefix: string): Promise<{ key: string; size: number }[]>;
  /** Object text, or null when the key does not exist. */
  get(key: string): Promise<string | null>;
  put(key: string, body: string): Promise<void>;
  /** 0090 §5: remove an object's current version (bucket versioning keeps history). */
  delete(key: string): Promise<void>;
}

export interface SkillFile {
  path: string;
  content: string;
}

export interface SkillSummary {
  id: string;
  description: string;
  /** Supporting files (SKILL.md excluded), sorted. */
  files: string[];
  updatedAt: string;
  /** Present only on listAllSkills rows — listSkills omits disabled entirely. */
  disabled?: boolean;
}

export interface Skill extends SkillSummary {
  /** Front matter stripped. */
  body: string;
  /** SKILL.md exactly as stored (front matter included). */
  raw: string;
  fileContents: SkillFile[];
  disabled: boolean;
  /** Manifest provenance, carried through lifecycle rewrites. */
  author?: string;
}

export interface SaveSkillInput {
  id: string;
  /** SKILL.md text, front matter (`description`, optional `status: disabled`) included. */
  body: string;
  files?: SkillFile[];
  author?: string;
}

export type StoreResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: "invalid" | "unconfigured" | "store-error" | "unknown-skill"; message: string };

export interface StoreStatus {
  configured: boolean;
  skillCount?: number;
  lastError?: string;
}

// ---- parsing & validation (pure) -------------------------------------

export interface ParsedSkillMarkdown {
  description: string;
  disabled: boolean;
  body: string;
}

export function parseSkillMarkdown(text: string): ParsedSkillMarkdown {
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const body = (front ? text.slice(front[0].length) : text).trim();
  const header = front?.[1] ?? "";
  const description = /^description:\s*(.+)$/m.exec(header)?.[1].trim().replace(/^(["'])(.*)\1$/, "$2") ?? "";
  const disabled = /^status:\s*disabled\s*$/m.test(header);
  return { description, disabled, body };
}

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

/** POSIX-relative: no leading `/`, no backslashes, no empty/`.`/`..` segments. */
export function validFilePath(path: string): boolean {
  if (!path || path.length > 200 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Issues with a proposed skill write; empty = valid. */
export function validateSkillInput(input: SaveSkillInput): string[] {
  const issues: string[] = [];
  if (!SKILL_ID.test(input.id)) issues.push("skill id must match ^[a-z][a-z0-9-]{0,40}$");
  const parsed = parseSkillMarkdown(input.body);
  if (!parsed.description) issues.push("SKILL.md front matter needs a non-empty `description:` line");
  else if (parsed.description.length > MAX_DESCRIPTION_CHARS) issues.push(`description exceeds ${MAX_DESCRIPTION_CHARS} characters`);
  if (!parsed.body) issues.push("SKILL.md has no body");
  const files = input.files ?? [];
  if (files.length + 1 > MAX_FILES) issues.push(`a skill holds at most ${MAX_FILES} files (SKILL.md included)`);
  let total = bytes(input.body);
  if (total > MAX_FILE_BYTES) issues.push(`SKILL.md exceeds ${MAX_FILE_BYTES / 1024} KiB`);
  const seen = new Set<string>();
  for (const file of files) {
    if (!validFilePath(file.path)) issues.push(`invalid file path "${file.path}" (POSIX-relative, no ".." or leading "/")`);
    else if (file.path === SKILL_FILE || file.path === MANIFEST_FILE) issues.push(`"${file.path}" is reserved`);
    else if (seen.has(file.path)) issues.push(`duplicate file path "${file.path}"`);
    seen.add(file.path);
    const size = bytes(file.content);
    if (size > MAX_FILE_BYTES) issues.push(`file "${file.path}" exceeds ${MAX_FILE_BYTES / 1024} KiB`);
    total += size;
  }
  if (total > MAX_SKILL_BYTES) issues.push(`skill exceeds ${MAX_SKILL_BYTES / 1024} KiB in total`);
  return issues;
}

const manifestSchema = z.object({
  files: z.array(z.string()),
  sizes: z.record(z.string(), z.number()),
  updatedAt: z.string(),
  author: z.string().optional(),
});
type Manifest = z.infer<typeof manifestSchema>;

// ---- config & gateway --------------------------------------------------

interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
}

function readConfig(): S3Config | null {
  const env = process.env;
  const endpoint = env.SKILLS_S3_ENDPOINT;
  const bucket = env.SKILLS_S3_BUCKET;
  const accessKeyId = env.SKILLS_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.SKILLS_S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  const trimmed = (env.SKILLS_S3_PREFIX ?? "").replace(/^\/+|\/+$/g, "");
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: env.SKILLS_S3_REGION || "us-east-1",
    prefix: trimmed ? `${trimmed}/` : "",
  };
}

function s3Gateway(config: S3Config): S3Gateway {
  const clientPromise = import("@aws-sdk/client-s3").then(
    (sdk) => ({
      sdk,
      client: new sdk.S3Client({
        endpoint: config.endpoint,
        region: config.region,
        forcePathStyle: true,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      }),
    }),
  );
  return {
    async list(prefix) {
      const { sdk, client } = await clientPromise;
      const out: { key: string; size: number }[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(
          new sdk.ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix, ContinuationToken: token }),
        );
        for (const object of page.Contents ?? []) if (object.Key) out.push({ key: object.Key, size: object.Size ?? 0 });
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    async get(key) {
      const { sdk, client } = await clientPromise;
      try {
        const res = await client.send(new sdk.GetObjectCommand({ Bucket: config.bucket, Key: key }));
        return (await res.Body?.transformToString("utf-8")) ?? "";
      } catch (err) {
        if ((err as { name?: string }).name === "NoSuchKey") return null;
        throw err;
      }
    },
    async put(key, body) {
      const { sdk, client } = await clientPromise;
      await client.send(
        new sdk.PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body, ContentType: key.endsWith(".json") ? "application/json" : "text/markdown; charset=utf-8" }),
      );
    },
    async delete(key) {
      const { sdk, client } = await clientPromise;
      await client.send(new sdk.DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },
  };
}

// ---- state --------------------------------------------------------------

interface Entry extends SkillSummary {
  disabled: boolean;
  manifest: Manifest;
}

interface Listing {
  at: number;
  ttl: number;
  entries: Map<string, Entry>;
  error?: string;
}

let injected: { gateway: S3Gateway; prefix: string } | null = null;
let listing: Listing | null = null;
let lastError: string | undefined;
const lru = new Map<string, Skill>();

/** Tests only: fake the bucket (null restores env-driven config). */
export function __setGatewayForTests(gateway: S3Gateway | null, prefix = ""): void {
  injected = gateway ? { gateway, prefix: prefix ? `${prefix.replace(/\/+$/g, "")}/` : "" } : null;
  __resetCachesForTests();
}

export function __resetCachesForTests(): void {
  listing = null;
  lastError = undefined;
  lru.clear();
  envGateway = null;
}

let envGateway: { key: string; gateway: S3Gateway; prefix: string } | null = null;

function backend(): { gateway: S3Gateway; prefix: string } | null {
  if (injected) return injected;
  const config = readConfig();
  if (!config) return null;
  const key = JSON.stringify(config);
  if (envGateway?.key !== key) envGateway = { key, gateway: s3Gateway(config), prefix: config.prefix };
  return envGateway;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function loadListing(b: { gateway: S3Gateway; prefix: string }): Promise<Listing> {
  const objects = await b.gateway.list(b.prefix);
  const byId = new Map<string, Map<string, number>>();
  for (const { key, size } of objects) {
    const rest = key.slice(b.prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 1) continue;
    const id = rest.slice(0, slash);
    if (!SKILL_ID.test(id)) continue;
    const files = byId.get(id) ?? new Map<string, number>();
    files.set(rest.slice(slash + 1), size);
    byId.set(id, files);
  }
  const entries = new Map<string, Entry>();
  await Promise.all(
    [...byId].map(async ([id, present]) => {
      try {
        const manifestText = await b.gateway.get(`${b.prefix}${id}/${MANIFEST_FILE}`);
        if (manifestText === null) return;
        const manifest = manifestSchema.parse(JSON.parse(manifestText));
        // Torn-write guard: every manifest file must exist at the size it names.
        if (!manifest.files.includes(SKILL_FILE)) return;
        if (!manifest.files.every((path) => present.get(path) === manifest.sizes[path])) return;
        const raw = await b.gateway.get(`${b.prefix}${id}/${SKILL_FILE}`);
        if (raw === null) return;
        const parsed = parseSkillMarkdown(raw);
        entries.set(id, {
          id,
          description: parsed.description,
          disabled: parsed.disabled,
          files: manifest.files.filter((path) => path !== SKILL_FILE).sort(),
          updatedAt: manifest.updatedAt,
          manifest,
        });
      } catch {
        // A malformed manifest or one unreadable skill never poisons the rest.
      }
    }),
  );
  return { at: Date.now(), ttl: LISTING_TTL_MS, entries };
}

async function currentListing(): Promise<Listing | null> {
  const b = backend();
  if (!b) return null;
  if (listing && Date.now() - listing.at < listing.ttl) return listing;
  try {
    listing = await loadListing(b);
    lastError = undefined;
  } catch (err) {
    lastError = message(err);
    listing = { at: Date.now(), ttl: ERROR_TTL_MS, entries: new Map(), error: lastError };
  }
  return listing;
}

// ---- reads ---------------------------------------------------------------

/** Every non-disabled skill, sorted by id. Empty when unconfigured or the store is down. */
export async function listSkills(): Promise<SkillSummary[]> {
  const current = await currentListing();
  if (!current) return [];
  return [...current.entries.values()]
    .filter((entry) => !entry.disabled)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ id, description, files, updatedAt }) => ({ id, description, files, updatedAt }));
}

/** 0090 §4: the catalog listing — disabled skills included and flagged;
 * callers (the Settings page) decide what showing them means. The
 * harness mount + instructions paths keep listSkills. */
export async function listAllSkills(): Promise<SkillSummary[]> {
  const current = await currentListing();
  if (!current) return [];
  return [...current.entries.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ id, description, files, updatedAt, disabled }) => ({ id, description, files, updatedAt, disabled }));
}

/** One skill with its files (disabled included — callers decide). Null when unknown, torn, or the store is down. */
export async function readSkill(id: string): Promise<Skill | null> {
  if (!SKILL_ID.test(id)) return null;
  const current = await currentListing();
  const entry = current?.entries.get(id);
  const b = backend();
  if (!entry || !b) return null;
  const cached = lru.get(id);
  if (cached && cached.updatedAt === entry.updatedAt) {
    lru.delete(id);
    lru.set(id, cached);
    return cached;
  }
  try {
    const texts = await Promise.all(
      entry.manifest.files.map(async (path) => [path, await b.gateway.get(`${b.prefix}${id}/${path}`)] as const),
    );
    if (texts.some(([, text]) => text === null)) return null;
    const content = new Map(texts as [string, string][]);
    const raw = content.get(SKILL_FILE)!;
    const parsed = parseSkillMarkdown(raw);
    const skill: Skill = {
      id,
      description: parsed.description,
      files: entry.files,
      updatedAt: entry.updatedAt,
      body: parsed.body,
      raw,
      disabled: parsed.disabled,
      fileContents: entry.files.map((path) => ({ path, content: content.get(path)! })),
      ...(entry.manifest.author ? { author: entry.manifest.author } : {}),
    };
    lru.delete(id);
    lru.set(id, skill);
    while (lru.size > LRU_SKILLS) lru.delete(lru.keys().next().value as string);
    return skill;
  } catch (err) {
    lastError = message(err);
    return null;
  }
}

/** A supporting file's content, or null when the skill or file is unknown. */
export async function readSkillFile(id: string, path: string): Promise<string | null> {
  const skill = await readSkill(id);
  return skill?.fileContents.find((file) => file.path === path)?.content ?? null;
}

// ---- write ----------------------------------------------------------------

/** Validate, then PUT every file and the manifest LAST. Never throws. */
export async function saveSkill(input: SaveSkillInput): Promise<StoreResult<{ id: string; files: string[] }>> {
  const issues = validateSkillInput(input);
  if (issues.length > 0) return { ok: false, code: "invalid", message: issues.join("; ") };
  const b = backend();
  if (!b) return { ok: false, code: "unconfigured", message: "The skills store is not configured (SKILLS_S3_* env)." };
  const files = input.files ?? [];
  const all: SkillFile[] = [{ path: SKILL_FILE, content: input.body }, ...files];
  const manifest: Manifest = {
    files: all.map((file) => file.path),
    sizes: Object.fromEntries(all.map((file) => [file.path, bytes(file.content)])),
    updatedAt: new Date().toISOString(),
    ...(input.author ? { author: input.author } : {}),
  };
  try {
    for (const file of all) await b.gateway.put(`${b.prefix}${input.id}/${file.path}`, file.content);
    await b.gateway.put(`${b.prefix}${input.id}/${MANIFEST_FILE}`, JSON.stringify(manifest));
  } catch (err) {
    lastError = message(err);
    return { ok: false, code: "store-error", message: `Could not write the skill: ${lastError}` };
  } finally {
    listing = null;
    lru.delete(input.id);
  }
  return { ok: true, id: input.id, files: files.map((file) => file.path) };
}

// ---- lifecycle (0090 §5) ---------------------------------------------------

/** Flip ONLY the front-matter status line in `raw`: add `status:
 * disabled` under the description when disabling, remove the line when
 * enabling. Everything else stays byte-for-byte. */
function withStatusLine(raw: string, disabled: boolean): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n)/.exec(raw);
  if (!front) return disabled ? `---\nstatus: disabled\n---\n${raw}` : raw;
  const [, header, newline] = front;
  const hasLine = /^status:[ \t]*disabled[ \t]*$/m.test(header);
  if (disabled === hasLine) return raw; // already there — nothing to write
  const next = disabled
    ? /^description:.*$/m.test(header)
      ? header.replace(/(^description:.*$)/m, "$1\nstatus: disabled")
      : `${header}\nstatus: disabled`
    : header.replace(/^status:[ \t]*disabled[ \t]*$\r?\n?/m, "").replace(/\n$/, "");
  // Function replacement: header content must not hit `$`-patterns.
  return raw.replace(front[0], () => `---\n${next}\n---${newline}`);
}

/** Disable/enable a skill (0090 §5) — the owner acting directly, the
 * same authority save_skill's approval grants. Reuses the saveSkill
 * write path (files, manifest LAST, cache invalidation) unchanged. */
export async function setSkillDisabled(id: string, disabled: boolean): Promise<StoreResult<{ id: string }>> {
  if (!SKILL_ID.test(id)) return { ok: false, code: "invalid", message: "skill id must match ^[a-z][a-z0-9-]{0,40}$" };
  const b = backend();
  if (!b) return { ok: false, code: "unconfigured", message: "The skills store is not configured (SKILLS_S3_* env)." };
  const skill = await readSkill(id);
  if (!skill) {
    return lastError
      ? { ok: false, code: "store-error", message: `Could not read the store: ${lastError}` }
      : { ok: false, code: "unknown-skill", message: `No skill "${id}" in the store.` };
  }
  const raw = withStatusLine(skill.raw, disabled);
  if (raw === skill.raw) return { ok: true, id };
  return saveSkill({
    id,
    body: raw,
    files: skill.fileContents,
    ...(skill.author ? { author: skill.author } : {}),
  });
}

/** Remove a skill's object family (0090 §5) — manifest FIRST (the
 * inverse of the write order: a torn delete never half-loads, readers
 * already skip a skill whose manifest is missing), then every file the
 * manifest names. Bucket versioning keeps the history. */
export async function deleteSkill(id: string): Promise<StoreResult<{ id: string }>> {
  if (!SKILL_ID.test(id)) return { ok: false, code: "invalid", message: "skill id must match ^[a-z][a-z0-9-]{0,40}$" };
  const b = backend();
  if (!b) return { ok: false, code: "unconfigured", message: "The skills store is not configured (SKILLS_S3_* env)." };
  const current = await currentListing();
  const entry = current?.entries.get(id);
  if (!current || !entry) {
    return current?.error || lastError
      ? { ok: false, code: "store-error", message: `Could not read the store: ${lastError}` }
      : { ok: false, code: "unknown-skill", message: `No skill "${id}" in the store.` };
  }
  try {
    await b.gateway.delete(`${b.prefix}${id}/${MANIFEST_FILE}`);
    for (const file of entry.manifest.files) await b.gateway.delete(`${b.prefix}${id}/${file}`);
  } catch (err) {
    lastError = message(err);
    return { ok: false, code: "store-error", message: `Could not delete the skill: ${lastError}` };
  } finally {
    listing = null;
    lru.delete(id);
  }
  return { ok: true, id };
}

/** Settings card: configured?, how many skills, why the last sync failed. */
export async function status(): Promise<StoreStatus> {
  const current = await currentListing();
  if (!current) return { configured: false };
  return {
    configured: true,
    skillCount: [...current.entries.values()].filter((entry) => !entry.disabled).length,
    ...(lastError ? { lastError } : {}),
  };
}

/** 0090 §2: the connector [Test] — one LIVE list against the bucket,
 * value-shaped, never throwing. Deliberately not the cached listing: a
 * test that echoed the cache could not see the outage it asks about. */
export async function pingStore(): Promise<{ ok: boolean; detail: string }> {
  const b = backend();
  if (!b) return { ok: false, detail: "not configured (SKILLS_S3_* env)" };
  try {
    await b.gateway.list(b.prefix);
    return { ok: true, detail: "connected" };
  } catch (err) {
    lastError = message(err);
    return { ok: false, detail: message(err) };
  }
}
