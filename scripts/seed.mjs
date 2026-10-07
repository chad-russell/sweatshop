import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * 0004 seed — db-first management (decision 1): entities live as rows;
 * edit this script and re-run to change them. Idempotent upserts.
 * Secrets come ONLY from env (same posture as .env.local); nothing
 * secret is ever committed:
 *   GITHUB_USERNAME + GITHUB_TOKEN      → github credential
 *   FORGEJO_URL + FORGEJO_USERNAME + FORGEJO_TOKEN → forgejo credential
 * Any credential section whose env is absent is skipped.
 */
const dbPath = process.env.SWEATSHOP_DB ?? path.join(process.cwd(), "data", "sweatshop.db");
mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");

const now = () => Date.now();

const upsert = (table, row) =>
  db
    .prepare(
      `insert into ${table} (${Object.keys(row).join(", ")}) values (${Object.keys(row)
        .map(() => "?")
        .join(", ")})
       on conflict(id) do update set ${Object.keys(row)
         .filter((k) => k !== "id" && k !== "created_at")
         .map((k) => `${k} = excluded.${k}`)
         .join(", ")}`,
    )
    .run(...Object.values(row));

// --- projects ---------------------------------------------------------
// Phase B spike project: a public repo, no credentials required to clone.
// Replace with real projects (or add a push-target repo) as desired.
// 0031: no sandbox configs — a project's image is projects.image_ref.
upsert("projects", {
  id: "spike",
  name: "Sandbox spike",
  description: "0004 Phase A/B verification project.",
  image_ref: null,
  created_at: now(),
});

upsert("project_repos", {
  id: "spike/is-odd",
  project_id: "spike",
  url: "https://github.com/jonschlinkert/is-odd",
  name: "is-odd",
  created_at: now(),
});

// Throwaway push target for sandbox verification (Chad: anything here is
// fair game).
upsert("project_repos", {
  id: "spike/scratch",
  project_id: "spike",
  url: "https://git.crussell.io/chad/sweatshop-e2e-scratch.git",
  name: "scratch",
  created_at: now(),
});

// 0016 preview guinea pig: Biblica's open-bible monorepo (public GitHub
// repo — clones anonymously). pnpm/turbo workspace; the previewable app
// is apps/web (Next 15 + Payload), so preview commands target it
// explicitly rather than the root `turbo dev` (which starts every app).
upsert("projects", {
  id: "open-bible",
  name: "open-bible",
  description: "Biblica open-bible monorepo. Preview app: apps/web (pnpm/turbo workspace).",
  image_ref: null,
  created_at: now(),
});

upsert("project_repos", {
  id: "open-bible/open-bible",
  project_id: "open-bible",
  url: "https://github.com/biblica/open-bible.git",
  name: "open-bible",
  created_at: now(),
});

// --- git credentials (env-gated) --------------------------------------
if (process.env.GITHUB_TOKEN && process.env.GITHUB_USERNAME) {
  upsert("git_credentials", {
    id: "github-chad",
    kind: "github",
    label: "GitHub (chad)",
    username: process.env.GITHUB_USERNAME,
    secret: process.env.GITHUB_TOKEN,
    base_url: null,
    created_at: now(),
  });
  console.log("seeded: github credential (github-chad)");
}

if (
  process.env.FORGEJO_TOKEN &&
  process.env.FORGEJO_USERNAME &&
  process.env.FORGEJO_URL
) {
  upsert("git_credentials", {
    id: "forgejo-chad",
    kind: "forgejo",
    label: "Forgejo (chad)",
    username: process.env.FORGEJO_USERNAME,
    secret: process.env.FORGEJO_TOKEN,
    base_url: process.env.FORGEJO_URL,
    created_at: now(),
  });
  console.log("seeded: forgejo credential (forgejo-chad)");
}

// --- machines (0009 / 0023) -------------------------------------------
// Seed machines are JSON under lib/machines/seeds/ — the catalog IS the
// seeds. Insert-only by default: a seed never overwrites a machine Chad
// has since edited in the app. `--replace` (0023) deletes the seed ids
// and reinserts them from the files (version resets to 1) — the catalog
// swap mode, run once at the 1.6 deploy. Run snapshots are never
// touched either way (0009 invariant). Definitions are validated by the
// app on read (db/machines.ts).
const replace = process.argv.includes("--replace");
const seedDir = path.join(process.cwd(), "lib", "machines", "seeds");
const seeds = readdirSync(seedDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((file) => JSON.parse(readFileSync(path.join(seedDir, file), "utf8")));
if (replace && seeds.length > 0) {
  const removed = db
    .prepare(`delete from machines where id in (${seeds.map(() => "?").join(", ")})`)
    .run(...seeds.map((s) => s.id));
  if (removed.changes) console.log(`replaced: machines ${seeds.map((s) => s.id).join(", ")}`);
}
for (const seed of seeds) {
  const inserted = db
    .prepare(
      `insert into machines (id, name, description, definition, version, created_at, updated_at)
       values (?, ?, ?, ?, 1, ?, ?) on conflict(id) do nothing`,
    )
    .run(seed.id, seed.name, seed.description ?? null, JSON.stringify(seed.definition), now(), now());
  if (inserted.changes) console.log(`seeded: machine ${seed.id}`);
}

console.log(`seed complete → ${dbPath}`);
