import path from "node:path";
import { defineConfig } from "vitest/config";
import { workflow } from "workflow/vite";

export default defineConfig({
  // 0010 spike: compile "use workflow"/"use step" in vitest so tests can
  // run real workflow runs (start/getRun) against the mock-LLM chat turn.
  plugins: [workflow()],
  resolve: {
    // Match tsconfig's "@/*" root alias for test-time resolution.
    alias: { "@": path.resolve(__dirname) },
  },
  test: {
    environment: "node",
    // Persist transforms between runs: vitest 5 flagged "Transforming modules
    // took 164.48s · 34% of tracked time, re-done on every run". Cache lives
    // in node_modules/.vitest-cache (docs default) — covered by .gitignore's
    // /node_modules and invalidated on reinstall. Safe for both load-bearing
    // behaviors: the cache key is sha1(file content + vite/vitest config
    // hash), never env, so SWEATSHOP_DB (a runtime value read per worker by
    // tests/setup.ts) can't be baked in; and the workflow() plugin doesn't
    // opt out (api.vitest.ignoreFsModuleCache), so its compiled "use workflow"
    // output is cached under the same content hash — config or plugin changes
    // re-key and recompute automatically.
    fsModuleCache: true,
    // Each test file runs in an isolated worker; the setup file gives it a
    // fresh migrated temp db via SWEATSHOP_DB before any module imports db().
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
  },
});
