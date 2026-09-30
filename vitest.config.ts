import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
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
