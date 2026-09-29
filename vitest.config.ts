import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Each test file runs in an isolated worker; the setup file gives it a
    // fresh migrated temp db via SWEATSHOP_DB before any module imports db().
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
  },
});
