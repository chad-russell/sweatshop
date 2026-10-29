import { describe, expect, it } from "vitest";
import { REPO_DOC_FILE_CAP, REPO_DOC_TOTAL_CAP, type RepoDoc } from "../lib/agent/repo-docs";
import {
  buildInstructions,
  buildProjectSection,
  buildRepoDocsSection,
  buildSkillsSection,
  SKILLS_FALLBACK,
  GIT_DEFAULT_SECTIONS,
  type ProjectContext,
} from "../workflows/chat/instructions";

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

  it("includes the project section only when a project is given", () => {
    const withoutProject = buildInstructions(base);
    expect(withoutProject).not.toContain("# Project");
    expect(withoutProject).not.toContain("do not call list_projects");

    const withProject = buildInstructions({
      ...base,
      project: { id: "gpl", name: "Grand Plan", description: "The big one.", repos: [], testCommand: null, branchPrefix: null },
    });
    expect(withProject).toContain("# Project");
    expect(withProject).toContain('This chat is in project "gpl" (Grand Plan): The big one.');
    expect(withProject).toContain("do not call list_projects to find it");
  });

  it("places the project section after host routing and before repo docs", () => {
    const out = buildInstructions({
      hasSandbox: true,
      hosts: [{ name: "bee", address: "10.0.0.1", user: "chad", apiBase: null }],
      repoDocs: [{ repo: "web", path: "/w/web/AGENTS.md", content: "Style guide." }],
      project: { id: "gpl", name: "Grand Plan", repos: [] },
    });
    const hostIdx = out.indexOf("exec is only for live state on a host");
    const projectIdx = out.indexOf("# Project");
    const repoIdx = out.indexOf("# Repo instructions");
    expect(hostIdx).toBeGreaterThanOrEqual(0);
    expect(projectIdx).toBeGreaterThan(hostIdx);
    expect(repoIdx).toBeGreaterThan(projectIdx);
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

  it("renders {{owner}}/{{owner's}} placeholders for the current SWEATSHOP_OWNER_NAME, in every section and the skill body", () => {
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

  it("base is plain {{owner}}/{{owner's}} placeholder text — never interpolated at the module level", () => {
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

describe("buildProjectSection", () => {
  const minimal: ProjectContext = { id: "gpl", name: "Grand Plan", repos: [] };

  it("names the project and tells the model not to call list_projects", () => {
    const section = buildProjectSection(minimal);
    expect(section).toContain('# Project\n\nThis chat is in project "gpl" (Grand Plan).');
    expect(section).toContain("You are already in this project — do not call list_projects to find it");
  });

  it("omits description, repos, test command, and branch prefix when absent", () => {
    const section = buildProjectSection(minimal);
    expect(section).not.toContain(":");
    expect(section).not.toContain("Repos:");
    expect(section).not.toContain("Test command:");
    expect(section).not.toContain("Branch prefix:");
  });

  it("includes every present field", () => {
    const section = buildProjectSection({
      id: "gpl",
      name: "Grand Plan",
      description: "World domination, one repo at a time.",
      repos: [
        { name: "web", url: "https://git.example/web.git" },
        { name: "infra", url: "https://git.example/infra.git" },
      ],
      testCommand: "npm test",
      branchPrefix: "gpl",
    });
    expect(section).toContain("World domination, one repo at a time.");
    expect(section).toContain("Repos: web (https://git.example/web.git), infra (https://git.example/infra.git).");
    expect(section).toContain("Test command: npm test.");
    expect(section).toContain("Branch prefix: gpl.");
  });

  it("caps a long description and a long test command, not the whole section", () => {
    const longText = "x".repeat(2_000);
    const section = buildProjectSection({ ...minimal, description: longText, testCommand: longText });
    expect(section.length).toBeLessThan(longText.length);
    const descMatch = /: (x+)…/.exec(section);
    expect(descMatch?.[1].length).toBe(500);
    expect(section).toContain("Test command: ");
  });
});

describe("0088: the # Skills appendix", () => {
  const base = { hasSandbox: true, hosts: [], repoDocs: [] as RepoDoc[] };
  const catalog = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, description: `does ${i}` }));

  it("lists one `id — description` line per skill", () => {
    expect(buildSkillsSection([{ id: "a", description: "Does A" }, { id: "b", description: "Does B" }])).toBe(
      "# Skills\n\na — Does A\nb — Does B",
    );
  });

  it("renders nothing for an empty or omitted catalog", () => {
    expect(buildSkillsSection([])).toBe("");
    expect(buildInstructions(base)).not.toContain("# Skills");
    expect(buildInstructions({ ...base, skillsCatalog: [] })).not.toContain("# Skills");
  });

  it("caps descriptions at ~200 chars and collapses whitespace", () => {
    const line = buildSkillsSection([{ id: "a", description: `${"x".repeat(250)}\nmore` }]).split("\n").pop()!;
    expect(line).toBe(`a — ${"x".repeat(200)}…`);
  });

  it("lists up to 20 skills, and falls back to the use_skill sentence beyond that", () => {
    expect(buildSkillsSection(catalog(20)).split("\n").length).toBe(2 + 20);
    expect(buildSkillsSection(catalog(21))).toBe(`# Skills\n\n${SKILLS_FALLBACK}`);
    expect(SKILLS_FALLBACK).toBe("use_skill with no id lists every skill.");
  });

  it("renders owner placeholders in descriptions", () => {
    process.env.SWEATSHOP_OWNER_NAME = "Pat";
    try {
      expect(buildSkillsSection([{ id: "a", description: "for {{owner}}" }])).toContain("a — for Pat");
    } finally {
      delete process.env.SWEATSHOP_OWNER_NAME;
    }
  });

  it("is appended to the instructions, and the base paragraph describes file loads", () => {
    const out = buildInstructions({ ...base, skillsCatalog: catalog(2) });
    expect(out).toContain("# Skills\n\ns0 — does 0\ns1 — does 1");
    expect(out).toContain(
      "Skills are runbooks: the appendix lists what exists; use_skill({id}) loads one into transcript history, and use_skill({id, file}) loads a supporting file.",
    );
  });
});
