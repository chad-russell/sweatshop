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
    // Each test file runs in an isolated worker; the setup file gives it a
    // fresh migrated temp db via SWEATSHOP_DB before any module imports db().
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
  },
});
