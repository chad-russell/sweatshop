import { shellQuote } from "@/lib/previews/process";

/**
 * 0017 phase 2: env resolution. Pure — imported by the service, the
 * tools, and the routes. Layers (later wins): the project setup's env
 * → the preview row's sparse overrides → the platform's PORT / HOST /
 * PREVIEW_HOST / PREVIEW_URL, applied by the caller and ALWAYS final,
 * so a preview can never misroute itself.
 *
 * Interpolation happens at resolution time against the platform
 * values: `${PREVIEW_HOST}`, `${PREVIEW_URL}`, `${PORT}`, `${HOST}`.
 * `${service:<name>:<port>}` resolves per-substrate once services
 * exist (phase 3) — until then it is a value-shaped error, never a
 * silent empty address. Any other `${…}` is an error naming the key:
 * an unresolvable reference in an env value is a setup mistake the
 * caller should show, not a string to pass through and debug inside
 * the app.
 */

export interface EnvResolution {
  env: Record<string, string>;
}

/** Resolves `${service:<name>…}` to the address the sandbox can dial. */
export type ServiceResolver = (name: string) => { address: string } | { error: string };

/** Build the resolution for one preview's launch. */
export function resolvePreviewEnv(
  base: Record<string, string>,
  overrides: Record<string, string> | null | undefined,
  /** Platform values (PORT/HOST/PREVIEW_HOST/PREVIEW_URL) — the only
   *  things plain `${…}` references may name. */
  platform: Record<string, string>,
  /** Substrate hook for `${service:<name>:<port>}` refs (phase 3). */
  resolveService?: ServiceResolver,
): EnvResolution | { error: string } {
  const merged: Record<string, string> = { ...base, ...(overrides ?? {}) };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    const resolved = interpolate(value, platform, key, resolveService);
    if ("error" in resolved) return resolved;
    out[key] = resolved.value;
  }
  return { env: out };
}

const REF = /\$\{([^}]+)\}/g;

function interpolate(
  value: string,
  platform: Record<string, string>,
  key: string,
  resolveService?: ServiceResolver,
): { value: string } | { error: string } {
  const refs = [...value.matchAll(REF)].map((m) => m[1]!);
  let out = value;
  for (const ref of refs) {
    if (ref.startsWith("service:")) {
      const match = /^service:([a-z0-9-]+)(?::(\d+))?$/.exec(ref);
      if (!match || !match[1]) {
        return { error: `env ${key}: \${${ref}} is not a service reference (service:<name>[:<port>])` };
      }
      if (!resolveService) {
        return { error: `env ${key}: \${${ref}} cannot resolve here (no services on this substrate)` };
      }
      const resolved = resolveService(match[1]);
      if ("error" in resolved) {
        return { error: `env ${key}: \${${ref}} — ${resolved.error}` };
      }
      const address = match[2] ? `${resolved.address}:${match[2]}` : resolved.address;
      out = out.replaceAll(`\${${ref}}`, address);
      continue;
    }
    const replacement = platform[ref];
    if (replacement === undefined) {
      return {
        error: `env ${key}: \${${ref}} is not a known reference (PREVIEW_HOST, PREVIEW_URL, PORT, HOST)`,
      };
    }
    out = out.replaceAll(`\${${ref}}`, replacement);
  }
  return { value: out };
}

/** Parse a pasted KEY=VALUE block (the editor's fast path). Blank lines
 *  and `#` comments are dropped; a line without `=` is an error naming
 *  the line. Values keep everything after the first `=`, unquoted
 *  unless the whole value is single/double-quoted. */
export function parseEnvBlock(text: string): { env: Record<string, string> } | { error: string } {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return { error: `not a KEY=VALUE line: "${line}"` };
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return { env };
}

/** Masked view for cards/sheets: keys visible, values fixed-mask. */
export function maskEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([k]) => [k, "••••••••"]));
}

/** The /work/.previews/<id>.env content — shell-sourceable, one quoted
 *  KEY=VALUE per line. */
export function envFileContent(env: Record<string, string>): string {
  return (
    Object.entries(env)
      .map(([k, v]) => `${k}=${shellQuote(v)}`)
      .join("\n") + "\n"
  );
}
