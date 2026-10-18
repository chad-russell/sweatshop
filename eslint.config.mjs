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
    // Workflow SDK local world: run state + the test executor's generated
    // flow bundles (0010) — generated and gitignored.
    ".workflow-data/**",
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
  // 0049: components draw read models, never the store layer — types come
  // from @/lib/read-models/*, queries go through API routes. `patterns`
  // (not `paths`) because the alias needs glob grammar to catch both the
  // bare "@/db" entry and deep imports like "@/db/organize".
  {
    files: ["components/**/*.tsx", "components/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/db", "@/db/*"],
              message: "read models live in @/lib/read-models; queries go through API routes",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
