import { describe, expect, it } from "vitest";
import { activeNavPage } from "../lib/sidebar-nav";

describe("activeNavPage (0040)", () => {
  it("lights Projects for the index and for a project's own page", () => {
    expect(activeNavPage("/projects")).toBe("projects");
    expect(activeNavPage("/p/gpl")).toBe("projects");
  });

  it("matches the other pages by top-level segment, including detail routes", () => {
    expect(activeNavPage("/inbox")).toBe("inbox");
    expect(activeNavPage("/prs")).toBe("prs"); // 0053: the PR dashboard
    expect(activeNavPage("/sandboxes")).toBe("sandboxes");
    expect(activeNavPage("/sandboxes/sb_123")).toBe("sandboxes");
    expect(activeNavPage("/previews")).toBe("previews");
    expect(activeNavPage("/settings")).toBe("settings");
    expect(activeNavPage("/changelog")).toBe("changelog"); // 0082
  });

  it("lights nothing on chats, runs, harness views or the new-chat page", () => {
    expect(activeNavPage("/")).toBeNull();
    expect(activeNavPage("/c/wrun_1")).toBeNull();
    expect(activeNavPage("/r/mr_1")).toBeNull();
    expect(activeNavPage("/h/pi/wrun_1")).toBeNull();
  });

  it("does not confuse a prefix with a segment", () => {
    expect(activeNavPage("/projectsfoo")).toBeNull();
    expect(activeNavPage("/inboxes")).toBeNull();
    expect(activeNavPage("/prss")).toBeNull();
  });
});
