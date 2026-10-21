import { describe, expect, it } from "vitest";
import { GET } from "../app/api/skills/route";

/** 0055 v7: the composer picker's data includes `mode` per skill so a
 *  later UI (PR 2) can distinguish modes from plain thread skills. */
describe("GET /api/skills", () => {
  it("includes mode: boolean per skill, true for the shipped ticket mode", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: { id: string; mode: boolean }[] };
    expect(body.skills.length).toBeGreaterThan(0);
    for (const skill of body.skills) expect(typeof skill.mode).toBe("boolean");
    expect(body.skills.find((s) => s.id === "ticket")?.mode).toBe(true);
    expect(body.skills.find((s) => s.id === "review")?.mode).toBe(false);
  });

  it("descriptions contain no unrendered placeholders", async () => {
    const body = (await (await GET()).json()) as { skills: { description: string }[] };
    for (const skill of body.skills) expect(skill.description).not.toContain("{{");
  });
});
