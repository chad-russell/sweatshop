import { describe, expect, it } from "vitest";
import { REPO_DOC_FILE_CAP, REPO_DOC_TOTAL_CAP, type RepoDoc } from "../lib/agent/repo-docs";
import { buildInstructions, buildRepoDocsSection, GIT_DEFAULT_SECTIONS } from "../workflows/chat/instructions";

/**
 * Pure routing-guidance additions to the turn's instructions: host
 * guidance gates on `hosts`, repo docs cap per file and in total. No
 * sandbox, db, or workflow run needed — buildInstructions takes plain
 * data.
 */

describe("buildInstructions", () => {
  const base = { hasSandbox: true, hosts: [], repoDocs: [] as RepoDoc[] };

  it("includes host routing only when there are hosts", () => {
    const withoutHosts = buildInstructions(base);
    expect(withoutHosts).not.toContain("exec is only for live state on a host");

    const withHosts = buildInstructions({
      ...base,
      hosts: [{ name: "bee", address: "10.0.0.1", user: "chad", apiBase: null }],
    });
    expect(withHosts).toContain("exec is only for live state on a host");
    expect(withHosts).toContain("Never edit a repo checkout on a host");
  });

  it("includes harness steering only when there is a sandbox", () => {
    const withSandbox = buildInstructions(base);
    expect(withSandbox).toContain("Hand any code change beyond a few lines to a harness");

    const withoutSandbox = buildInstructions({ ...base, hasSandbox: false });
    expect(withoutSandbox).not.toContain("Hand any code change beyond a few lines to a harness");
  });

  it("appends the skill body last, unchanged from the prior inline shape", () => {
    const withSkill = buildInstructions({
      ...base,
      skill: { id: "ship", title: "Ship", body: "Do the ship thing." },
    });
    expect(withSkill).toContain('# Skill: Ship\n\nThis thread runs the "ship" skill — follow it.\n\nDo the ship thing.');
    expect(withSkill.endsWith("Do the ship thing.")).toBe(true);
  });

  it("keeps the base text intact with no additions", () => {
    const plain = buildInstructions({ hasSandbox: false, hosts: [], repoDocs: [] });
    expect(plain).toContain("You are sweatshop's agent");
    expect(plain).not.toContain("# Repo instructions");
  });

  it("ships ask_owner, never the old ask_chad name", () => {
    const plain = buildInstructions({ hasSandbox: false, hosts: [], repoDocs: [] });
    expect(plain).toContain("ask_owner");
    expect(plain).not.toContain("ask_chad");
  });

  it("0058: renders {{owner}}/{{owner's}} placeholders for the current SWEATSHOP_OWNER_NAME, in every section and the skill body", () => {
    const saved = process.env.SWEATSHOP_OWNER_NAME;
    try {
      process.env.SWEATSHOP_OWNER_NAME = "Riley";
      const out = buildInstructions({
        hasSandbox: true,
        hosts: [{ name: "bee", address: "10.0.0.1", user: "chad", apiBase: null }],
        repoDocs: [],
        skill: { id: "ship", title: "Ship", body: "Check with {{owner}} before {{owner's}} release." },
      });
      expect(out).toContain("Riley");
      expect(out).toContain("Check with Riley before Riley's release.");
      expect(out).not.toContain("Chad");
      expect(out).not.toContain("{{owner");
    } finally {
      if (saved === undefined) delete process.env.SWEATSHOP_OWNER_NAME;
      else process.env.SWEATSHOP_OWNER_NAME = saved;
    }
  });

  it("0054: omitting `sections` reproduces today's exact output (regression guard)", () => {
    const withoutSections = buildInstructions(base);
    const explicitDefaults = buildInstructions({
      ...base,
      sections: {
        base: GIT_DEFAULT_SECTIONS.base,
        harnessSteering: GIT_DEFAULT_SECTIONS.harness_steering,
        hostRouting: GIT_DEFAULT_SECTIONS.host_routing,
      },
    });
    expect(explicitDefaults).toBe(withoutSections);
  });

  it("0054: a custom `sections` override replaces each block verbatim", () => {
    const out = buildInstructions({
      ...base,
      hosts: [{ name: "bee", address: "10.0.0.1", user: "chad", apiBase: null }],
      sections: { base: "CUSTOM BASE", harnessSteering: "CUSTOM HARNESS", hostRouting: "CUSTOM HOST" },
    });
    expect(out).toContain("CUSTOM BASE");
    expect(out).toContain("CUSTOM HARNESS");
    expect(out).toContain("CUSTOM HOST");
    expect(out).not.toContain("You are sweatshop's agent");
    expect(out).not.toContain("Use bash to look around");
    expect(out).not.toContain("exec is only for live state on a host");
  });
});

describe("GIT_DEFAULT_SECTIONS", () => {
  it("exposes the exact text buildInstructions falls back to", () => {
    expect(GIT_DEFAULT_SECTIONS.base).toContain("You are sweatshop's agent");
    expect(GIT_DEFAULT_SECTIONS.harness_steering).toContain("Use bash to look around");
    expect(GIT_DEFAULT_SECTIONS.host_routing).toContain("exec is only for live state on a host");
  });

  it("0058: base is plain {{owner}}/{{owner's}} placeholder text — never interpolated at the module level", () => {
    expect(GIT_DEFAULT_SECTIONS.base).toContain("{{owner}}");
    expect(GIT_DEFAULT_SECTIONS.base).toContain("{{owner's}}");
    expect(GIT_DEFAULT_SECTIONS.base).not.toContain("Chad");
  });
});

describe("buildRepoDocsSection", () => {
  it("is empty with no docs", () => {
    expect(buildRepoDocsSection([])).toBe("");
  });

  it("includes a repo's doc verbatim under its own section header", () => {
    const section = buildRepoDocsSection([{ repo: "web", path: "/work/c1/web/AGENTS.md", content: "Follow the style guide." }]);
    expect(section).toBe("# Repo instructions: web (/work/c1/web/AGENTS.md)\n\nFollow the style guide.");
  });

  it("cuts a file over the per-file cap and points at the full path", () => {
    const content = "a".repeat(REPO_DOC_FILE_CAP + 5_000);
    const section = buildRepoDocsSection([{ repo: "big", path: "/work/c1/big/AGENTS.md", content }]);
    expect(section.length).toBeLessThan(content.length);
    expect(section).toContain("cat /work/c1/big/AGENTS.md");
    expect(section.length - "# Repo instructions: big (/work/c1/big/AGENTS.md)\n\n".length).toBeLessThanOrEqual(
      REPO_DOC_FILE_CAP + 200,
    );
  });

  it("drops whole files once the running total would cross the total cap, with a pointer", () => {
    const perFile = Math.floor(REPO_DOC_FILE_CAP * 0.9);
    const docs: RepoDoc[] = Array.from({ length: 4 }, (_, i) => ({
      repo: `repo${i}`,
      path: `/work/c1/repo${i}/AGENTS.md`,
      content: "x".repeat(perFile),
    }));
    const section = buildRepoDocsSection(docs);
    expect(section).toContain("# Repo instructions: repo0");
    expect(section).toContain("# Repo instructions: repo1");
    // 4 files at ~0.9*cap each comfortably exceed the 48 KB total cap.
    expect(section).toContain("# Repo instructions: more");
    expect(section).toContain("cat /work/c1/repo");
    expect(section.length).toBeLessThan(REPO_DOC_TOTAL_CAP + perFile + 1_000);
  });

  it("always includes at least the first file even if it alone is large", () => {
    const content = "y".repeat(REPO_DOC_FILE_CAP);
    const section = buildRepoDocsSection([{ repo: "only", path: "/w/only/AGENTS.md", content }]);
    expect(section).toContain("# Repo instructions: only");
    expect(section).not.toContain("# Repo instructions: more");
  });
});
