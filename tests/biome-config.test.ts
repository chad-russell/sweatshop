import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const cli = path.join(process.cwd(), "node_modules/@biomejs/biome/bin/biome");
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sweatshop-biome-"));
  copyFileSync("biome.jsonc", path.join(dir, "biome.jsonc"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function lintImport(file: string, source: string) {
  // Use real files: Biome's stdin mode emits processed source, not lint diagnostics.
  const target = path.join(dir, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, source);
  return spawnSync(
    process.execPath,
    [cli, "lint", "--vcs-enabled=false", file],
    { cwd: dir, encoding: "utf8" },
  );
}

describe("Biome component/store boundary (0049, 0085)", () => {
  it.each(["@/db", "@/db/organize", "@/db/nested/store"])(
    "rejects component imports from %s",
    (module) => {
      const result = lintImport("components/boundary-probe.tsx", `export { db } from "${module}";`);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("read models live in @/lib/read-models");
    },
  );

  it("also rejects type-only store imports", () => {
    const result = lintImport("components/nested/boundary-probe.ts", 'export type { Row } from "@/db/chat";');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("read models live in @/lib/read-models");
  });

  it("allows read-model imports in components", () => {
    const result = lintImport("components/boundary-probe.tsx", 'export type { Row } from "@/lib/read-models/chat";');
    expect(result.status, result.stderr).toBe(0);
  });

  it("allows store imports outside components", () => {
    const result = lintImport("lib/boundary-probe.ts", 'export { db } from "@/db";');
    expect(result.status, result.stderr).toBe(0);
  });
});
