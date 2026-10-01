import { describe, expect, it } from "vitest";
import { sessionModelId, sessionProjectId } from "../lib/session-attributes";

const session = (attributes: unknown) => ({
  auth: { initiator: { attributes } },
});

describe("session attribute readers", () => {
  it("reads string project and model attributes", () => {
    const s = session({ project: "spike", model: "glm-5.3" });
    expect(sessionProjectId(s)).toBe("spike");
    expect(sessionModelId(s)).toBe("glm-5.3");
  });

  it("returns null for missing, non-string, or absent attributes", () => {
    expect(sessionProjectId(session({}))).toBeNull();
    expect(sessionProjectId(session({ project: 42 }))).toBeNull();
    expect(sessionModelId(session({ model: null }))).toBeNull();
  });

  it("tolerates a missing or null initiator", () => {
    expect(sessionProjectId({ auth: {} })).toBeNull();
    expect(sessionModelId({ auth: { initiator: null } })).toBeNull();
  });
});
