import { z } from "zod";

/**
 * 0017: the JSON a preview setup row stores — everything a preview of
 * this project needs to run. Pure (no Node imports) so the routes, the
 * store, the workflow body, and the UI can all import it, exactly like
 * machine definitions (0014).
 *
 * Substrate-free by the portability contract: no container names, no
 * network names, no podman/docker specifics. `${service:<name>:<port>}`
 * and `${PREVIEW_URL}` are the only wiring syntax; both resolve
 * per-substrate at launch (phases 2–3).
 */

/** A relative directory inside the repo — `apps/web`, `.`. */
const relDir = z
  .string()
  .regex(/^[\w@.-]+(\/[\w@.-]+)*$/, "a relative directory like apps/web (no leading /, no ..)");

const envMap = z.record(z.string(), z.string());

/** A declared service dependency (phase 3 runs these; the shape ships now). */
export const previewSetupServiceSchema = z.object({
  /** Name used in `${service:<name>:<port>}` references. */
  name: z.string().regex(/^[a-z][a-z0-9-]{0,29}$/, "lowercase kebab service name"),
  /** OCI image ref — portable across every substrate. */
  image: z.string().min(1),
  command: z.string().optional(),
  env: envMap.default({}),
  port: z.number().int().min(1).max(65_535),
});

export const previewSetupSchema = z.object({
  /** project_repos.id the setup runs in. */
  repo: z.string().min(1),
  /** Where the server command runs, relative to the repo root. */
  workDir: relDir,
  /** Dependency install, run at the repo root (workspaces install there). */
  install: z.string().min(1),
  /** One-shot post-services step (migrations); once per sandbox. */
  provision: z.string().min(1).optional(),
  /** One-shot data step, after provision (0017 amendment); once per
   *  sandbox, idempotent by convention — bundled, fetched from a
   *  source, or a dump restore; all just a command + env. */
  seed: z.string().min(1).optional(),
  /** The server command. `$PORT` is the preview's port. */
  command: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  /** Env layer 1 (per-preview overrides and the platform's PORT/HOST/
   *  PREVIEW_* win — 0017). */
  env: envMap.default({}),
  services: z.array(previewSetupServiceSchema).default([]),
});

export type PreviewSetupService = z.infer<typeof previewSetupServiceSchema>;
export type PreviewSetupDefinition = z.infer<typeof previewSetupSchema>;

export type ParsedSetup =
  | { ok: true; definition: PreviewSetupDefinition }
  | { ok: false; issues: string[] };

/** Validate a stored or submitted definition; value-shaped, never throws. */
export function parsePreviewSetup(value: unknown): ParsedSetup {
  const result = previewSetupSchema.safeParse(value);
  if (result.success) return { ok: true, definition: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((i) => `${i.path.join(".") || "definition"}: ${i.message}`),
  };
}

/** Parse the row's JSON column; an unreadable row surfaces its reason. */
export function parsePreviewSetupJson(json: string): ParsedSetup {
  try {
    return parsePreviewSetup(JSON.parse(json));
  } catch {
    return { ok: false, issues: ["definition: not valid JSON"] };
  }
}
