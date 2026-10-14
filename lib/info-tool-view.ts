import { objectOf } from "./tool-fields";

/**
 * Normalisers for the "read-only information" tools — use_skill,
 * system_docs, list_projects, get/save_preview_setup, gh, forgejo and
 * cancel_run. Same posture as web-tool-view / machine-tool-view: the
 * tools return value-shaped JSON (`{ok:true,…}` / `{ok:false,code,message}`)
 * and everything here is pure and defensive about stored input/output.
 */

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The first `# Heading` of a markdown body. */
export function h1Of(markdown: string): string | undefined {
  return /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
}

// --- use_skill -----------------------------------------------------------------

export interface SkillListItem {
  id: string;
  title: string;
  description: string;
}

export type SkillView =
  | { kind: "list"; skills: SkillListItem[] }
  | { kind: "bound"; id: string; title: string; note?: string; body: string };

export function skillView(output: unknown): SkillView | undefined {
  const o = objectOf(output);
  if (!o || o.ok !== true) return undefined;
  if (typeof o.skill === "string" && typeof o.id === "string") {
    return { kind: "bound", id: o.id, title: h1Of(o.skill) ?? o.id, note: str(o.note), body: o.skill };
  }
  if (Array.isArray(o.skills)) return { kind: "list", skills: skillItems(o.skills) };
  return undefined;
}

/** The skill list a failed call carries (unknown id → "here is what exists"). */
export function skillItems(raw: unknown): SkillListItem[] {
  const out: SkillListItem[] = [];
  for (const item of arr(raw)) {
    const s = objectOf(item);
    const id = str(s?.id);
    if (!s || !id) continue;
    out.push({ id, title: str(s.title) ?? id, description: str(s.description) ?? "" });
  }
  return out;
}

// --- system_docs ---------------------------------------------------------------

export interface DocTopicView {
  topic: string;
  title: string;
}

export type DocsView =
  | { kind: "list"; topics: DocTopicView[] }
  | { kind: "doc"; topic: string; title: string; doc: string };

export function docTopics(raw: unknown): DocTopicView[] {
  const out: DocTopicView[] = [];
  for (const item of arr(raw)) {
    const t = objectOf(item);
    const topic = str(t?.topic);
    if (!t || !topic) continue;
    out.push({ topic, title: str(t.title) ?? topic });
  }
  return out;
}

export function docsView(output: unknown): DocsView | undefined {
  const o = objectOf(output);
  if (!o || o.ok !== true) return undefined;
  if (typeof o.doc === "string" && typeof o.topic === "string") {
    return { kind: "doc", topic: o.topic, title: h1Of(o.doc) ?? o.topic, doc: o.doc };
  }
  if (Array.isArray(o.topics)) return { kind: "list", topics: docTopics(o.topics) };
  return undefined;
}

// --- list_projects -------------------------------------------------------------

export interface ProjectRow {
  id: string;
  name: string;
  description?: string;
  repos: { name: string; url: string }[];
  testCommand?: string;
  branchPrefix?: string;
}

export function projectsView(output: unknown): ProjectRow[] | undefined {
  const o = objectOf(output);
  if (!o || o.ok !== true || !Array.isArray(o.projects)) return undefined;
  const rows: ProjectRow[] = [];
  for (const item of o.projects) {
    const p = objectOf(item);
    const id = str(p?.id);
    if (!p || !id) continue;
    rows.push({
      id,
      name: str(p.name) ?? id,
      description: str(p.description),
      repos: arr(p.repos).flatMap((r) => {
        const repo = objectOf(r);
        const name = str(repo?.name);
        return repo && name ? [{ name, url: str(repo.url) ?? "" }] : [];
      }),
      testCommand: str(p.testCommand),
      branchPrefix: str(p.branchPrefix),
    });
  }
  return rows;
}

// --- get/save_preview_setup ----------------------------------------------------

export interface SetupView {
  repo: string;
  workDir: string;
  install: string;
  migrate?: string;
  seed?: string;
  command: string;
  port: number;
  env: [string, string][];
  services: { name: string; image: string; port: number; command?: string }[];
}

/** `null` = the project has no saved setup yet; `undefined` = not readable. */
export function setupView(output: unknown): SetupView | null | undefined {
  const o = objectOf(output);
  if (!o || o.ok !== true || !("setup" in o)) return undefined;
  if (o.setup === null) return null;
  const s = objectOf(o.setup);
  const command = str(s?.command);
  if (!s || !command) return undefined;
  return {
    repo: str(s.repo) ?? "",
    workDir: str(s.workDir) ?? ".",
    install: str(s.install) ?? "",
    migrate: str(s.migrate),
    seed: str(s.seed),
    command,
    port: typeof s.port === "number" ? s.port : 0,
    env: Object.entries(objectOf(s.env) ?? {}).map(([k, v]) => [k, String(v)] as [string, string]),
    services: arr(s.services).flatMap((svc) => {
      const x = objectOf(svc);
      const name = str(x?.name);
      return x && name
        ? [{ name, image: str(x.image) ?? "", port: typeof x.port === "number" ? x.port : 0, command: str(x.command) }]
        : [];
    }),
  };
}

/** Env values that look like secrets are masked in the card. */
export function maskEnvValue(key: string, value: string): string {
  return /(secret|token|password|passwd|key|credential)/i.test(key) && value && !value.startsWith("${")
    ? "••••••"
    : value;
}

// --- gh / forgejo --------------------------------------------------------------

export interface QueryView {
  /** What was run, as a command line the terminal card prints. */
  command: string;
  output: string;
}

/** gh: `{ok, command, output}`; the command line is also derivable from input args. */
export function ghView(input: unknown, output: unknown): QueryView {
  const args = arr(objectOf(input)?.args).filter((a): a is string => typeof a === "string");
  const o = objectOf(output);
  return {
    command: str(o?.command) ?? (args.length ? `gh ${args.map(shellQuote).join(" ")}` : "gh"),
    output: str(o?.output) ?? "",
  };
}

/** forgejo: a GET with query params, printed curl-style. */
export function forgejoView(input: unknown, output: unknown): QueryView {
  const i = objectOf(input);
  const path = str(i?.path) ?? "";
  const params = Object.entries(objectOf(i?.params) ?? {}).filter(([, v]) => typeof v === "string" && v !== "");
  const query = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
  return {
    command: `forgejo GET ${path}${query ? `?${query}` : ""}`,
    output: prettyJson(str(objectOf(output)?.output) ?? ""),
  };
}

function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Re-indent a JSON body for reading; anything that does not parse is returned as-is. */
export function prettyJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

// --- note ----------------------------------------------------------------------

/** The agent's note to itself: the input text, else the result with its "noted: " echo stripped. */
export function noteView(input: unknown, output: unknown): string {
  const fromInput = str(objectOf(input)?.note);
  if (fromInput) return fromInput;
  return typeof output === "string" ? output.replace(/^noted:\s*/, "").trim() : "";
}

// --- cancel_run ----------------------------------------------------------------

export function cancelView(input: unknown, output: unknown): { id: string; note?: string } {
  const o = objectOf(output);
  return { id: str(o?.runId) ?? str(objectOf(input)?.runId) ?? str(objectOf(input)?.id) ?? "…", note: str(o?.note) };
}

/** `hc_…` call, `c_…` child thread — a human word for the id. */
export function runKind(id: string): string {
  return id.startsWith("hc_") ? "harness call" : id.startsWith("c_") ? "child thread" : "run";
}
