import { describe, expect, it } from "vitest";
import { parseChangelog } from "../lib/changelog";

describe("parseChangelog", () => {
  it("groups tagged bullets under their date heading, newest first as written", () => {
    const md = `# Changelog

<!-- header comment explaining the format -->

## 2026-10-26

- **Added** in-app changelog.
- **Fixed** a crash on empty projects.

## 2026-10-20

- **Changed** the default theme.
`;
    expect(parseChangelog(md)).toEqual([
      {
        date: "2026-10-26",
        entries: [
          { tag: "Added", text: "in-app changelog." },
          { tag: "Fixed", text: "a crash on empty projects." },
        ],
      },
      {
        date: "2026-10-20",
        entries: [{ tag: "Changed", text: "the default theme." }],
      },
    ]);
  });

  it("falls back to a generic tag for an untagged bullet", () => {
    const md = `## 2026-10-26\n\n- a plain bullet with no tag\n`;
    expect(parseChangelog(md)).toEqual([
      { date: "2026-10-26", entries: [{ tag: "Note", text: "a plain bullet with no tag" }] },
    ]);
  });

  it("skips malformed lines and anything before the first date heading", () => {
    const md = `# Changelog\nsome stray prose\n* not a dash bullet\n\n## 2026-10-26\n- **Added** the thing.\nnot a bullet at all\n`;
    expect(parseChangelog(md)).toEqual([
      { date: "2026-10-26", entries: [{ tag: "Added", text: "the thing." }] },
    ]);
  });

  it("returns an empty list for an empty or header-only file", () => {
    expect(parseChangelog("")).toEqual([]);
    expect(parseChangelog("# Changelog\n\n<!-- format comment -->\n")).toEqual([]);
  });

  it("ignores a bullet with an empty tag or empty text", () => {
    const md = `## 2026-10-26\n- **** nothing in the tag\n- **Tag**\n`;
    expect(parseChangelog(md)).toEqual([
      {
        date: "2026-10-26",
        entries: [
          { tag: "Note", text: "**** nothing in the tag" },
          { tag: "Note", text: "**Tag**" },
        ],
      },
    ]);
  });
});
