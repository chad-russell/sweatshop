import { describe, expect, it } from "vitest";
import { GET } from "../app/api/skills/route";

describe("GET /api/skills", () => {
  it("returns the bindable runbook catalog without mode metadata", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: { id: string; mode?: unknown }[] };
    expect(body.skills.length).toBeGreaterThan(0);
    for (const skill of body.skills) expect(skill).not.toHaveProperty("mode");
  });

  it("descriptions contain no unrendered placeholders", async () => {
    const body = (await (await GET()).json()) as { skills: { description: string }[] };
    for (const skill of body.skills) expect(skill.description).not.toContain("{{");
  });
});
