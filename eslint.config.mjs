import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // eve runtime artifacts (compiled agents, workflow state) — generated,
    // gitignored, and huge.
    ".eve/**",
    ".output/**",
    // Workflow SDK transform output (generated flow routes).
    "app/.well-known/**",
    // Vendored skill demos under .agents/ are reference material, not
    // product code — not held to house lint rules.
    ".agents/**",
    // Registry-managed components (ai-elements/shadcn add) — overwritten
    // by their CLIs, not held to house lint rules.
    "components/ai-elements/**",
    "components/ui/**",
  ]),
]);

export default eslintConfig;
