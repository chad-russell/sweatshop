import { GIT_DEFAULT_SECTIONS } from "@/workflows/chat/instructions";
import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  getTarget,
  parseTarget,
  PROMPT_SECTION_MAX_BYTES,
  listTargets,
  listVersions,
  publishEdit,
  resetToGitDefault,
  restoreVersion,
  SECTION_KEYS,
  type SectionKey,
} from "@/db/prompt-settings";
import { buildInstructions } from "@/workflows/chat/instructions";

export const dynamic = "force-dynamic";

type Target = { kind: "section"; key: SectionKey };

/**
 * Only used to reconstruct a target from GET's three separate query
 * params (`kind`/`key`/`id`) into the single clean shape the store
 * expects — a different job from the store's own `parseTarget` (which
 * guards a single already-combined JSON value against unknown keys and
 * wrong types). The store re-validates whatever this returns, so a gap
 * here is a 400, never a 500.
 */
function targetOf(value: unknown): Target | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.kind === "section" && typeof v.key === "string" && (SECTION_KEYS as readonly string[]).includes(v.key)) {
    return { kind: "section", key: v.key as SectionKey };
  }
  return null;
}

/**
 * 0054 hardening: the store validates target/patch/expectedVersion/
 * note/version at runtime and returns `{ok:false, code:"invalid", ...}`
 * instead of throwing on anything malformed — so every PUT path below
 * passes the request body straight through as `unknown`, no casts. This
 * is also why every code this function can see maps to a 4xx: nothing
 * reaching it is a server failure.
 */
function response(result: { ok: boolean; code?: string; issues?: string[]; current?: unknown; version?: number }) {
  return NextResponse.json(result, { status: result.ok ? 200 : result.code === "conflict" ? 409 : 400 });
}

/** Assemble the same representative sandbox/host preview for saved and draft reads. */
function assembledPreview(override?: { key: SectionKey; body: string }) {
  const section = (key: SectionKey) => {
    if (override?.key === key) return override.body;
    const row = getTarget(db(), { kind: "section", key });
    if (!row) throw new Error(`prompt section "${key}" failed to seed`);
    return row.body;
  };
  return buildInstructions({
    hasSandbox: true,
    hosts: [{ name: "sample", address: "sample.internal", user: "agent", apiBase: null }],
    repoDocs: [],
    sections: { base: section("base"), harnessSteering: section("harness_steering"), hostRouting: section("host_routing") },
  });
}

export async function POST(request: Request) {
  const input: unknown = await request.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { action, target, body, ...extra } = input as Record<string, unknown>;
  if (action !== "preview" || Object.keys(extra).length > 0) {
    return NextResponse.json({ error: "Expected only action, target, and body for preview" }, { status: 400 });
  }
  const parsed = parseTarget(target);
  if (!parsed.ok) return response(parsed);
  if (typeof body !== "string" || new TextEncoder().encode(body).byteLength > PROMPT_SECTION_MAX_BYTES) {
    return NextResponse.json({ error: `Preview body must be a string of at most ${PROMPT_SECTION_MAX_BYTES} bytes` }, { status: 400 });
  }
  try {
    return NextResponse.json({ prompt: assembledPreview({ key: parsed.target.key, body }) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "failed to assemble preview" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const action = url.searchParams.get("action") ?? "list";
  if (action === "list") {
    return NextResponse.json({ targets: listTargets(db()) });
  }
  if (action === "preview") {
    try {
      return NextResponse.json({ prompt: assembledPreview() });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "failed to assemble preview" }, { status: 500 });
    }
  }
  const target = targetOf({ kind: url.searchParams.get("kind"), key: url.searchParams.get("key") });
  if (!target) return NextResponse.json({ error: "Invalid target" }, { status: 400 });
  if (action === "default") {
    return NextResponse.json({ body: GIT_DEFAULT_SECTIONS[target.key] });
  }
  if (action === "detail") return NextResponse.json({ current: getTarget(db(), target), versions: listVersions(db(), target) });
  if (action === "history") return NextResponse.json({ versions: listVersions(db(), target) });
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

export async function PUT(request: Request) {
  const input = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!input) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  // Every field below rides into the store as `unknown` — publishEdit/
  // restoreVersion/resetToGitDefault own ALL validation (shape, unknown
  // keys, types, caps) and never throw; this route makes no claim about
  // what's valid beyond which action was asked for.
  if (input.action === "restore") {
    return response(restoreVersion(db(), input.target, { version: input.version, expectedVersion: input.expectedVersion }));
  }
  if (input.action === "reset") {
    return response(resetToGitDefault(db(), input.target, { expectedVersion: input.expectedVersion }));
  }
  if (input.action === "publish") {
    return response(publishEdit(db(), input.target, { patch: input.patch, expectedVersion: input.expectedVersion, note: input.note }));
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
