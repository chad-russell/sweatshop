import type { Db } from "@/db";
import { listGitCredentialViews } from "@/lib/git-hosts/credential-admin";
import { codexCredential } from "@/lib/harness-auth/codex";
import { cursorCredential } from "@/lib/harness-auth/cursor";
import { PROVIDER_KEY_ENV } from "@/lib/providers/catalog";
import { modelsView } from "@/lib/providers/catalog-view";
import { providerKey, providerModelsUrl } from "@/lib/providers/registry";
import { pingStore, status as skillsStatus } from "@/lib/skills/store";

/**
 * 0090 §2: the connector model — every external account sweatshop
 * authenticates as, as rows for the /settings/connections cards, plus
 * the [Test] dispatch. Status is a value shape built from existing
 * reads: NEVER a secret value or token text, only counts and hints.
 * The live checks are cheap (one models list, one local expiry read)
 * and never throw — a connector that cannot be tested says so instead
 * (claude/git: honest echo, cursor/codex: local credential read).
 */

export interface ConnectorRow {
  id: string;
  kind: "provider" | "harness" | "git" | "skills";
  label: string;
  statusText: string;
  ok: boolean;
  /** One-line note under the row: the next action, or the failure reason. */
  meta?: string;
  /** The exact line `meta` tells you to set, when it is copyable. */
  copy?: string;
}

export type ConnectorTest = { ok: boolean; detail: string };

const DAYS_MS = 86_400_000;
const TEST_TIMEOUT_MS = 8_000;

/** Same wording as the models page's login rows. */
function loginStatus(expiresAt: number | null): string {
  if (expiresAt === null) return "logged in";
  const days = Math.floor((expiresAt - Date.now()) / DAYS_MS);
  return days >= 0 ? `logged in · expires in ${days} day${days === 1 ? "" : "s"}` : "logged in";
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** `@user · N credentials` — the first username stands in when a host has several. */
function gitStatus(creds: { username: string }[]): string {
  if (creds.length === 0) return "no credentials";
  return `@${creds[0].username} · ${creds.length} credential${creds.length === 1 ? "" : "s"}`;
}

export async function buildConnectors(db: Db): Promise<ConnectorRow[]> {
  const view = modelsView(db);
  const rows: ConnectorRow[] = [];

  for (const p of view.providers) {
    rows.push(
      p.available
        ? { id: p.id, kind: "provider", label: p.label, statusText: `key set · ${p.models.length} models`, ok: true }
        : {
            id: p.id,
            kind: "provider",
            label: p.label,
            statusText: "key not set",
            ok: false,
            meta: `Set ${PROVIDER_KEY_ENV[p.id]} in ~/sweatshop/.env.local`,
            copy: `${PROVIDER_KEY_ENV[p.id]}=`,
          },
    );
  }

  rows.push(
    view.claude.configured
      ? { id: "claude", kind: "harness", label: "claude (subscription)", statusText: "token set", ok: true }
      : {
          id: "claude",
          kind: "harness",
          label: "claude (subscription)",
          statusText: "token not set",
          ok: false,
          meta: "Set CLAUDE_CODE_OAUTH_TOKEN in ~/sweatshop/.env.local",
          copy: "CLAUDE_CODE_OAUTH_TOKEN=",
        },
  );

  const cursor = cursorCredential();
  rows.push({
    id: "cursor",
    kind: "harness",
    label: "cursor",
    statusText: cursor.ok ? loginStatus(cursor.expiresAt) : "not logged in",
    ok: cursor.ok,
    ...(!cursor.ok ? { meta: cursor.message } : {}),
  });

  const codex = codexCredential();
  rows.push({
    id: "codex",
    kind: "harness",
    label: "codex (ChatGPT)",
    statusText: codex.ok ? loginStatus(codex.expiresAt) : "not logged in",
    ok: codex.ok,
    ...(!codex.ok ? { meta: codex.message } : {}),
  });

  // Git: one row per host — github.com always (it is the default host),
  // each Forgejo base URL when it has credentials.
  const creds = listGitCredentialViews(db);
  const hosts = new Map<string, { username: string }[]>([["github.com", creds.filter((c) => c.kind === "github")]]);
  for (const c of creds) {
    if (c.kind !== "forgejo") continue;
    const host = c.baseUrl ?? "forgejo";
    hosts.set(host, [...(hosts.get(host) ?? []), c]);
  }
  for (const [host, list] of hosts) {
    rows.push({
      id: `git:${host}`,
      kind: "git",
      label: `Git · ${host}`,
      statusText: gitStatus(list),
      ok: list.length > 0,
      ...(list.length === 0 ? { meta: "Add a credential below — used for sandbox clones, pushes and PRs." } : {}),
    });
  }

  const skills = await skillsStatus();
  const count = skills.skillCount ?? 0;
  rows.push(
    !skills.configured
      ? {
          id: "skills",
          kind: "skills",
          label: "Skills store (S3)",
          statusText: "not configured",
          ok: false,
          meta: "Set the SKILLS_S3_* environment variables in ~/sweatshop/.env.local",
        }
      : {
          id: "skills",
          kind: "skills",
          label: "Skills store (S3)",
          statusText: skills.lastError
            ? `error: ${skills.lastError}`
            : `connected · ${count} skill${count === 1 ? "" : "s"}`,
          ok: !skills.lastError,
          ...(skills.lastError ? { meta: "Run Test for a fresh check, or fix the store and reload." } : {}),
        },
  );

  return rows;
}

// ---- the [Test] dispatch -------------------------------------------------

async function testProviderModelList(provider: "glm" | "gloo"): Promise<ConnectorTest> {
  const key = providerKey(provider);
  if (!key) return { ok: false, detail: "no key set" };
  try {
    const res = await fetch(providerModelsUrl(provider), {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    return res.ok
      ? { ok: true, detail: `reachable (HTTP ${res.status})` }
      : { ok: false, detail: `HTTP ${res.status} from ${provider}` };
  } catch (err) {
    return { ok: false, detail: message(err) };
  }
}

/** OpenRouter's models list is public — reachable without a key, noted when so. */
async function testOpenRouter(): Promise<ConnectorTest> {
  const key = providerKey("openrouter");
  try {
    const res = await fetch(providerModelsUrl("openrouter"), {
      ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status} from openrouter` };
    return { ok: true, detail: key ? `reachable (HTTP ${res.status})` : `reachable (HTTP ${res.status}) · no key set` };
  } catch (err) {
    return { ok: false, detail: message(err) };
  }
}

/** No Anthropic call in this phase — echo the token's presence honestly. */
function testClaude(): ConnectorTest {
  return process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
    ? { ok: true, detail: "token present (live check not supported yet)" }
    : { ok: false, detail: "token not set" };
}

/** The credential read is local (file + JWT expiry) — no harness round-trip. */
function testHarnessLogin(id: "cursor" | "codex"): ConnectorTest {
  const cred = id === "cursor" ? cursorCredential() : codexCredential();
  return cred.ok ? { ok: true, detail: loginStatus(cred.expiresAt) } : { ok: false, detail: cred.message };
}

/** No server-side git host check exists; count what is stored, honestly. */
function testGitHost(db: Db, host: string): ConnectorTest {
  const creds = listGitCredentialViews(db).filter((c) =>
    host === "github.com" ? c.kind === "github" : c.baseUrl === host,
  );
  return creds.length > 0
    ? {
        ok: true,
        detail: `${creds.length} credential${creds.length === 1 ? "" : "s"} stored (live host check not supported)`,
      }
    : { ok: false, detail: "no credentials stored" };
}

export async function testConnector(db: Db, id: string): Promise<ConnectorTest> {
  switch (id) {
    case "glm":
    case "gloo":
      return testProviderModelList(id);
    case "openrouter":
      return testOpenRouter();
    case "claude":
      return testClaude();
    case "cursor":
    case "codex":
      return testHarnessLogin(id);
    case "skills":
      return pingStore();
    default:
      return id.startsWith("git:")
        ? testGitHost(db, id.slice("git:".length))
        : { ok: false, detail: "unknown connector" };
  }
}
