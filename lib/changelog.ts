import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 0085: the in-app changelog, parsed from the root `CHANGELOG.md` at
 * request time — no db table, no seeding. Synchronous `readFileSync`
 * against `process.cwd()`; the production deploy (0045) runs `next
 * start` against the full checkout, so the root file is already there.
 *
 * The parser is tolerant on purpose (0085 decision 3): an untagged
 * bullet falls back to a generic tag instead of being dropped, and any
 * line that isn't a date heading or a bullet (blank lines, the header
 * comment, stray prose) is silently skipped.
 */

export const CHANGELOG_FALLBACK_TAG = "Note";

export interface ChangelogEntry {
  tag: string;
  text: string;
}

export interface ChangelogDate {
  date: string;
  entries: ChangelogEntry[];
}

const DATE_HEADING = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/;
const BULLET = /^-\s+(.+)$/;
const TAGGED_BULLET = /^\*\*([^*]+)\*\*\s*(.+)$/;

/** Pure parse — exported separately so tests don't need a real file. */
export function parseChangelog(markdown: string): ChangelogDate[] {
  const dates: ChangelogDate[] = [];
  let current: ChangelogDate | null = null;

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();

    const heading = DATE_HEADING.exec(line);
    if (heading) {
      current = { date: heading[1], entries: [] };
      dates.push(current);
      continue;
    }

    if (!current) continue; // preamble/header comment before the first date

    const bullet = BULLET.exec(line);
    if (!bullet) continue; // not a bullet — skip rather than fail

    const body = bullet[1].trim();
    const tagged = TAGGED_BULLET.exec(body);
    if (tagged && tagged[1].trim() && tagged[2].trim()) {
      current.entries.push({ tag: tagged[1].trim(), text: tagged[2].trim() });
    } else {
      current.entries.push({ tag: CHANGELOG_FALLBACK_TAG, text: body });
    }
  }

  return dates;
}

/** Reads and parses the repo root's CHANGELOG.md; [] if it's missing or unreadable. */
export function loadChangelog(root: string = process.cwd()): ChangelogDate[] {
  let raw: string;
  try {
    raw = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  } catch {
    return [];
  }
  return parseChangelog(raw);
}
