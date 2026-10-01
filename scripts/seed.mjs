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

// --- sandbox configs -------------------------------------------------
upsert("sandbox_configs", {
  id: "default",
  name: "Default sandbox",
  provider: "docker",
  image_ref: null, // unset = eve's published sandbox image
  network_policy: "allow-all",
  notes: "Shared base image (0004 decision 2).",
  created_at: now(),
});

// --- projects ---------------------------------------------------------
// Phase B spike project: a public repo, no credentials required to clone.
// Replace with real projects (or add a push-target repo) as desired.
upsert("projects", {
  id: "spike",
  name: "Sandbox spike",
  description: "0004 Phase A/B verification project.",
  sandbox_config_id: "default",
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

// --- machines (0009) -------------------------------------------------
// Seed machines are JSON under lib/machines/seeds/. Insert-only: a seed
// never overwrites a machine Chad has since edited in the app. Their
// definitions are validated by the app on read (db/machines.ts).
const seedDir = path.join(process.cwd(), "lib", "machines", "seeds");
for (const file of readdirSync(seedDir).filter((f) => f.endsWith(".json")).sort()) {
  const seed = JSON.parse(readFileSync(path.join(seedDir, file), "utf8"));
  const inserted = db
    .prepare(
      `insert into machines (id, name, description, definition, version, created_at, updated_at)
       values (?, ?, ?, ?, 1, ?, ?) on conflict(id) do nothing`,
    )
    .run(seed.id, seed.name, seed.description ?? null, JSON.stringify(seed.definition), now(), now());
  if (inserted.changes) console.log(`seeded: machine ${seed.id}`);
}

console.log(`seed complete → ${dbPath}`);
