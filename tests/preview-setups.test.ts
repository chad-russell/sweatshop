import { describe, expect, it } from "vitest";
import { db } from "../db";
import { projectRepos, projects } from "../db/schema";
import {
  deletePreviewSetup,
  getPreviewSetup,
  getPreviewSetupDefinition,
  savePreviewSetup,
} from "../db/preview-setups";
import { parsePreviewSetup } from "../lib/previews/setup";

/**
 * 0017 phase 1: the preview setup store — one validated row per
 * project, upserted whole, value-shaped on bad input.
 */

const valid = {
  repo: "p_setup/web",
  workDir: "apps/web",
  install: "pnpm install",
  provision: "pnpm -w run migrate",
  command: "pnpm run dev -H 0.0.0.0 -p $PORT",
  port: 3000,
  env: { PAYLOAD_SECRET: "s3cret" },
  services: [
    { name: "db", image: "docker.io/library/postgres:18-alpine", env: { POSTGRES_PASSWORD: "postgres" }, port: 5432 },
  ],
};

db().insert(projects).values({ id: "p_setup", name: "Setup", createdAt: 0 }).onConflictDoNothing().run();
db()
  .insert(projectRepos)
  .values({ id: "p_setup/web", projectId: "p_setup", url: "https://git.example/web.git", name: "web", createdAt: 0 })
  .onConflictDoNothing()
  .run();

describe("0017 preview setups", () => {
  it("round-trips a definition and defaults the optionals", () => {
    const saved = savePreviewSetup(db(), "p_setup", valid);
    expect(saved).toMatchObject({ ok: true });
    const read = getPreviewSetup(db(), "p_setup");
    expect(read).toMatchObject({ ok: true });
    if (!read.ok || !read.setup) throw new Error("unreachable");
    expect(read.setup.definition.services[0]!.name).toBe("db");
    // defaults filled on save
    expect(savePreviewSetup(db(), "p_setup", { ...valid, env: undefined, services: undefined }))
      .toMatchObject({ ok: true });

    const def = getPreviewSetupDefinition(db(), "p_setup");
    expect(def?.env).toEqual({});
    expect(def?.services).toEqual([]);
    expect(def?.workDir).toBe("apps/web");
  });

  it("upserts one row per project, keeping its id", () => {
    const first = savePreviewSetup(db(), "p_setup", valid);
    if (!first.ok) throw new Error(first.issues.join("; "));
    const second = savePreviewSetup(db(), "p_setup", { ...valid, port: 5173 });
    expect(second).toMatchObject({ ok: true });
    if (!second.ok) throw new Error(second.issues.join("; "));
    expect(second.setup.id).toBe(first.setup.id);
    expect(second.setup.definition.port).toBe(5173);
    expect(getPreviewSetupDefinition(db(), "p_setup")?.port).toBe(5173);
  });

  it("rejects invalid definitions with issues, saving nothing", () => {
    const before = getPreviewSetup(db(), "p_setup");
    const bad = savePreviewSetup(db(), "p_setup", { repo: "x", workDir: "/abs", install: "", command: "y", port: 99999 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.length).toBeGreaterThan(0);
    expect(getPreviewSetup(db(), "p_setup")).toEqual(before);
  });

  it("reports an unreadable stored row instead of throwing", () => {
    db().$client
      .prepare("update preview_setups set definition = ? where project_id = ?")
      .run("{not json", "p_setup");
    const read = getPreviewSetup(db(), "p_setup");
    expect(read.ok).toBe(false);
    // definition accessor degrades to null (launch falls back to input)
    expect(getPreviewSetupDefinition(db(), "p_setup")).toBeNull();
    // and a re-save repairs it
    expect(savePreviewSetup(db(), "p_setup", valid)).toMatchObject({ ok: true });
  });

  it("null project → null setup; delete works", () => {
    expect(getPreviewSetupDefinition(db(), null)).toBeNull();
    expect(getPreviewSetupDefinition(db(), "no-such-project")).toBeNull();
    expect(deletePreviewSetup(db(), "p_setup")).toBe(true);
    expect(getPreviewSetupDefinition(db(), "p_setup")).toBeNull();
    expect(deletePreviewSetup(db(), "p_setup")).toBe(false);
  });

  it("parses wiring syntax fields without substrate checks (review rule, not schema)", () => {
    // An env value naming a host is legitimate config — the audit rule
    // bans *this substrate's* identifiers, enforced by review, not zod.
    const parsed = parsePreviewSetup({ ...valid, env: { S3_ENDPOINT: "http://10.10.0.12:3402" } });
    expect(parsed.ok).toBe(true);
  });
});
