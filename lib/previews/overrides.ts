import { z } from "zod";
import { serviceSpecSchema } from "@/lib/sandboxes/service-spec";

/**
 * 0019: the ONE shape of "values for this preview" that create and
 * confirm both accept — the API body, the dialog's request, and the
 * branch.ts input types all derive from it. Pure (no Node imports).
 *
 * Every field is optional: an unset field falls back to the project's
 * saved setup. Empty strings and empty env/services collapse to unset,
 * so "send nothing" and "send blank" mean the same thing.
 */

const text = z
  .string()
  .transform((v) => v.trim())
  .transform((v) => (v === "" ? undefined : v))
  .optional();

const port = z
  .union([z.number(), z.string()])
  .transform((v) => (v === "" ? undefined : Number(v)))
  .pipe(z.number().int("port must be 1–65535").min(1, "port must be 1–65535").max(65_535, "port must be 1–65535").optional())
  .optional();

const nonEmpty = <T extends z.ZodTypeAny>(schema: T) =>
  schema.transform((v: unknown) => {
    if (Array.isArray(v)) return v.length ? v : undefined;
    return v && Object.keys(v as object).length ? v : undefined;
  });

export const previewOverridesSchema = z.object({
  workDir: text,
  install: text,
  command: text,
  port,
  label: text,
  /** Sparse env overrides for this preview, merged over the setup's. */
  env: nonEmpty(z.record(z.string(), z.string("env values must be strings"))).optional(),
  provision: text,
  seed: text,
  services: nonEmpty(z.array(serviceSpecSchema)).optional(),
});

export type PreviewOverrides = {
  workDir?: string;
  install?: string;
  command?: string;
  port?: number;
  label?: string;
  env?: Record<string, string>;
  provision?: string;
  seed?: string;
  services?: z.infer<typeof serviceSpecSchema>[];
};

/** Parse a request body's override fields; a bad field is an error
 *  string naming it (the routes answer 400 with it). */
export function parsePreviewOverrides(body: unknown): { overrides: PreviewOverrides } | { error: string } {
  const result = previewOverridesSchema.safeParse(body ?? {});
  if (!result.success) {
    return {
      error: result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
    };
  }
  // Drop undefined keys so spreads and `??` fallbacks behave.
  return { overrides: Object.fromEntries(Object.entries(result.data).filter(([, v]) => v !== undefined)) as PreviewOverrides };
}
