import { describe, expect, it } from "vitest";
import { listDocTopics, readDoc } from "../lib/agent/tools/docs";

/**
 * The capability-docs core (the skills-pattern v1): docs/agent/*.md
 * are the agent's on-demand depth. Topic names are one path segment —
 * never a traversal — and unknown topics return the listing so the
 * model repairs its call.
 */

describe("capability docs", () => {
  it("lists the shipped topics from their H1s", async () => {
    const topics = await listDocTopics();
    const names = topics.map((t) => t.topic);
    expect(names).toContain("machines");
    expect(names).toContain("projects");
    for (const t of topics) expect(t.title).toMatch(/\S/);
  });

  it("reads a doc by topic", async () => {
    const result = await readDoc("machines");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.topic).toBe("machines");
      expect(result.doc).toContain("# Machines");
    }
  });

  it("rejects unknown and malformed topics with the listing", async () => {
    for (const bad of ["../schema", "nope", "UPPER", "a/b", " . ", ""]) {
      const result = await readDoc(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.topics.length).toBeGreaterThan(0);
    }
  });

  it("finds every topic the instructions advertise", async () => {
    // The instructions name five capabilities; every one must have a
    // doc (the contract between the prompt and the files).
    for (const topic of ["projects", "previews", "machines", "sandboxes", "models"]) {
      expect((await readDoc(topic)).ok, topic).toBe(true);
    }
  });
});
