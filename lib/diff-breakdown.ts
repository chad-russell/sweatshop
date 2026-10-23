/**
 * 0059: where a branch's diff actually lives — parse `git diff --numstat
 * -z` output into rows, then sort those rows into fixed categories (first
 * match wins) so a big PR's size can be read as "mostly lockfile" or
 * "mostly code" at a glance. Pure — no db, no git — so both the sandbox
 * gather (lib/agent/tools/pr-preview.ts) and the UI (components/
 * diff-breakdown.tsx) can share one source of truth.
 */

export interface NumstatRow {
  path: string;
  added: number;
  deleted: number;
  binary: boolean;
}

/**
 * `-z` terminates each field with NUL instead of newline. A renamed path
 * drops the normal single `<path>` field (empty) in favor of two
 * NUL-terminated fields, old then new — we keep the new path. A binary
 * file reports `-` for both counts instead of numbers.
 */
export function parseNumstatZ(output: string): NumstatRow[] {
  const tokens = output.split("\0");
  const rows: NumstatRow[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i] ?? "";
    if (token === "") {
      i++;
      continue;
    }
    const tab1 = token.indexOf("\t");
    const tab2 = token.indexOf("\t", tab1 + 1);
    const addedStr = token.slice(0, tab1);
    const deletedStr = token.slice(tab1 + 1, tab2);
    const pathField = token.slice(tab2 + 1);
    let path: string;
    if (pathField === "") {
      const oldPath = tokens[i + 1] ?? "";
      const newPath = tokens[i + 2] ?? "";
      path = newPath || oldPath;
      i += 3;
    } else {
      path = pathField;
      i += 1;
    }
    const binary = addedStr === "-" && deletedStr === "-";
    rows.push({
      path,
      added: binary ? 0 : Number(addedStr) || 0,
      deleted: binary ? 0 : Number(deletedStr) || 0,
      binary,
    });
  }
  return rows;
}

export interface DiffBreakdownCategory {
  key: string;
  label: string;
  files: number;
  added: number;
  deleted: number;
}

export interface DiffBreakdown {
  files: number;
  added: number;
  deleted: number;
  categories: DiffBreakdownCategory[];
}

interface CategoryDef {
  key: string;
  label: string;
  /** Empty patterns = the catch-all, always last. */
  patterns: string[];
}

/** Fixed in code (decided) — first match wins, in this order. Mocks are
 *  deliberately Tests, not Code. */
const CATEGORY_DEFS: CategoryDef[] = [
  {
    key: "generated",
    label: "Generated",
    patterns: [
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "*.lock",
      "drizzle/meta/**",
      ".agents/**",
      "*.snap",
      "skills-lock.json",
    ],
  },
  {
    key: "tests",
    label: "Tests",
    patterns: [
      "tests/**",
      "**/*.test.*",
      "**/*.spec.*",
      "**/__tests__/**",
      "**/fixtures/**",
      "**/mock*",
      "**/*mock*.*",
    ],
  },
  { key: "docs", label: "Docs", patterns: ["docs/**", "**/*.md", "**/*.mdx"] },
  { key: "migrations", label: "Migrations", patterns: ["drizzle/*.sql"] },
  {
    key: "config",
    label: "Config",
    patterns: ["*.config.*", "package.json", "tsconfig*.json", ".github/**", "Containerfile*"],
  },
  { key: "code", label: "Code", patterns: [] },
];

/** Fixed display order of category keys (0078: shared with `mergeBreakdowns`
 *  so a multi-PR aggregate sorts the same way as a single PR's table). */
export const DIFF_CATEGORY_ORDER: readonly string[] = CATEGORY_DEFS.map((def) => def.key);

const REGEXP_SPECIAL = /[.+^${}()|[\]\\]/;

/** A small glob dialect: `**` matches across directories (and, as
 *  `**\/`, zero of them too), `*` matches within one segment. */
function globToRegExp(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 3;
      } else {
        re += ".*";
        i += 2;
      }
    } else if (c === "*") {
      re += "[^/]*";
      i += 1;
    } else if (REGEXP_SPECIAL.test(c)) {
      re += `\\${c}`;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

const PATTERN_REGEXPS = new Map<string, RegExp>();

function patternRegExp(pattern: string): RegExp {
  const cached = PATTERN_REGEXPS.get(pattern);
  if (cached) return cached;
  const re = globToRegExp(pattern);
  PATTERN_REGEXPS.set(pattern, re);
  return re;
}

/** A pattern with no `/` matches the basename at any depth; one with a
 *  `/` matches the full path, anchored at the repo root. */
function matchesPattern(path: string, pattern: string): boolean {
  const subject = pattern.includes("/") ? path : (path.slice(path.lastIndexOf("/") + 1) || path);
  return patternRegExp(pattern).test(subject);
}

function categoryFor(path: string): CategoryDef {
  for (const def of CATEGORY_DEFS) {
    if (def.patterns.length === 0) return def;
    if (def.patterns.some((pattern) => matchesPattern(path, pattern))) return def;
  }
  return CATEGORY_DEFS[CATEGORY_DEFS.length - 1]!;
}

/** Sort numstat rows into the fixed categories; empty categories are
 *  left out, in fixed display order (ending with the Code catch-all). */
export function classifyDiff(rows: readonly NumstatRow[]): DiffBreakdown {
  const byKey = new Map<string, DiffBreakdownCategory>();
  let files = 0;
  let added = 0;
  let deleted = 0;
  for (const row of rows) {
    files += 1;
    added += row.added;
    deleted += row.deleted;
    const def = categoryFor(row.path);
    const existing = byKey.get(def.key);
    if (existing) {
      existing.files += 1;
      existing.added += row.added;
      existing.deleted += row.deleted;
    } else {
      byKey.set(def.key, { key: def.key, label: def.label, files: 1, added: row.added, deleted: row.deleted });
    }
  }
  const categories = CATEGORY_DEFS.map((def) => byKey.get(def.key)).filter(
    (c): c is DiffBreakdownCategory => c !== undefined,
  );
  return { files, added, deleted, categories };
}

/** Value-shape guard for a tool result read back off the wire (create_pr's
 *  persisted output) — never throws on an older result without one. */
export function isDiffBreakdown(value: unknown): value is DiffBreakdown {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.files === "number" &&
    typeof v.added === "number" &&
    typeof v.deleted === "number" &&
    Array.isArray(v.categories)
  );
}

