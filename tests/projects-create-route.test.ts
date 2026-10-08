import { describe, expect, it } from "vitest";
import { db } from "../db";
import { projectRepos } from "../db/schema";
import { POST as createProjectRoute } from "../app/api/projects/route";

/**
 * 0033 B-UI: the create-project route — the UI half of the
 * createProject core. Status discipline mirrors the folders route:
 * 201 created, 400 invalid, 409 conflict.
 */

const json = (body: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(body) });

describe("POST /api/projects", () => {
  it("creates a project with repos and returns 201", async () => {
    const res = await createProjectRoute(
      json({
        id: "ui-gpl",
        name: "GPL",
        repos: [{ name: "360-gpl", url: "https://github.com/TangoGroup/360-gpl.git" }],
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { project: { id: string }; repos: string[] };
    expect(body.project.id).toBe("ui-gpl");
    expect(body.repos).toEqual(["360-gpl"]);
    const rows = db().select().from(projectRepos).all();
    expect(rows.some((r) => r.id === "ui-gpl/360-gpl" && r.url === "https://github.com/TangoGroup/360-gpl")).toBe(true);
  });

  it("rejects bad shapes with 400 and duplicates with 409", async () => {
    expect((await createProjectRoute(json({ id: "x" }))).status).toBe(400);
    expect((await createProjectRoute(json({ id: "x", name: "x", repos: [{ name: "a" }] }))).status).toBe(400);
    expect((await createProjectRoute(json({ id: "BAD ID", name: "x" }))).status).toBe(400);
    expect((await createProjectRoute(json({ id: "ui-gpl", name: "again" }))).status).toBe(409);
  });
});
