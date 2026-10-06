import { z } from "zod";

/**
 * A declared sandbox service — a sibling container (db, s3…) the
 * sandbox's workload depends on (0017 phase 3). Pure (no Node imports)
 * so the preview setup's schema, the UI, and the substrate backend
 * (services.ts) all import the one definition; it lives on the sandbox
 * side because the sandbox owns the service, previews only declare it.
 *
 * Substrate-free by the portability contract: an OCI image ref, an
 * entrypoint argv, env, a port — no container or network names.
 */
export const serviceSpecSchema = z.object({
  /** Name used in `${service:<name>:<port>}` references. */
  name: z.string().regex(/^[a-z][a-z0-9-]{0,29}$/, "lowercase kebab service name"),
  /** OCI image ref — portable across every substrate. */
  image: z.string().min(1),
  command: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  port: z.number().int().min(1).max(65_535),
});

export type ServiceSpec = z.infer<typeof serviceSpecSchema>;
