import { parseEnvBlock } from "@/lib/previews/env";
import type { PreviewSetupDefinition } from "@/lib/previews/setup";

/**
 * The setup editor's form values and the two conversions between them
 * and a definition (0017 amendment / 0019). Pure — no React — so the
 * editor, the New-preview flow and tests share it. The definition's
 * shape and validation live in lib/previews/setup.ts; this only unwraps
 * the textarea conventions (env blocks, string ports).
 */

export interface ServiceRow {
  name: string;
  image: string;
  port: string;
  command: string;
  envText: string;
}

export interface SetupFormValues {
  workDir: string;
  install: string;
  migrate: string;
  seed: string;
  command: string;
  port: string;
  envText: string;
  services: ServiceRow[];
}

export const emptySetupForm: SetupFormValues = {
  workDir: "",
  install: "",
  migrate: "",
  seed: "",
  command: "",
  port: "",
  envText: "",
  services: [],
};

const envToText = (env: Record<string, string> | undefined): string =>
  Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${v.includes(" ") ? JSON.stringify(v) : v}`)
    .join("\n");

export function setupFormFromDefinition(d: PreviewSetupDefinition): SetupFormValues {
  return {
    workDir: d.workDir,
    install: d.install,
    migrate: d.migrate ?? "",
    seed: d.seed ?? "",
    command: d.command,
    port: String(d.port),
    envText: envToText(d.env),
    services: d.services.map((s) => ({
      name: s.name,
      image: s.image,
      port: String(s.port),
      command: s.command ?? "",
      envText: envToText(s.env),
    })),
  };
}

/** The form's values as a definition (repo injected by the host); a
 * bad env block or service shape is an error string for the host to
 * show. The store's zod remains the authority — this only unwraps the
 * textarea conventions. */
export function definitionFromSetupForm(
  v: SetupFormValues,
  repo: string,
): { definition: PreviewSetupDefinition } | { error: string } {
  const env = parseEnvBlock(v.envText);
  if ("error" in env) return { error: env.error };
  const services: PreviewSetupDefinition["services"] = [];
  for (const [i, s] of v.services.entries()) {
    if (!s.name.trim() || !s.image.trim()) {
      return { error: `service ${i + 1}: name and image are required` };
    }
    const port = Number(s.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return { error: `service ${s.name}: port must be 1–65535` };
    }
    const senv = parseEnvBlock(s.envText);
    if ("error" in senv) return { error: `service ${s.name}: ${senv.error}` };
    services.push({
      name: s.name.trim(),
      image: s.image.trim(),
      port,
      ...(s.command.trim() ? { command: s.command.trim() } : {}),
      env: senv.env ?? {},
    });
  }
  return {
    definition: {
      repo,
      workDir: v.workDir.trim() || ".",
      install: v.install,
      ...(v.migrate.trim() ? { migrate: v.migrate.trim() } : {}),
      ...(v.seed.trim() ? { seed: v.seed.trim() } : {}),
      command: v.command,
      port: Number(v.port),
      env: env.env ?? {},
      services,
    },
  };
}

/** The create/confirm request body for a FIRST-FILL (no saved setup):
 *  the whole definition's values plus this preview's label. Fields the
 *  user left blank are omitted so the server falls back to defaults
 *  (lib/previews/overrides.ts); a malformed env block or service is an
 *  error string for the dialog to show. */
export function overridesFromSetupForm(
  values: SetupFormValues,
  repoId: string,
  label: string,
): Record<string, unknown> | { error: string } {
  const built = definitionFromSetupForm(values, repoId);
  if ("error" in built) return built;
  const d = built.definition;
  return {
    ...(values.workDir.trim() ? { workDir: d.workDir } : {}),
    ...(values.install.trim() ? { install: d.install } : {}),
    ...(values.command.trim() ? { command: d.command } : {}),
    ...(values.port.trim() ? { port: d.port } : {}),
    ...(label.trim() ? { label: label.trim() } : {}),
    ...(d.migrate ? { migrate: d.migrate } : {}),
    ...(d.seed ? { seed: d.seed } : {}),
    ...(d.services.length ? { services: d.services } : {}),
    ...(d.env && Object.keys(d.env).length ? { env: d.env } : {}),
  };
}

/** Whether the form carries enough to launch without a scan. */
export const isLaunchable = (values: SetupFormValues): boolean =>
  Boolean(values.command.trim() && values.install.trim() && values.port.trim());
