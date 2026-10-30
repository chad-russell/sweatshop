# 0090 — Settings redesign + a real skills catalog

Status: **draft 1, 2026-10-30 — awaiting Chad's approval before implementation.**

Supersedes nothing structural; grows out of 0088 §Surfaces (the
read-only Skills card) and restyles 0021 §6 (the settings surfaces).

## Why

Chad (2026-10-30): "Help me make the settings page better in general,
better design. Take inspiration from what T3 Code does — they have a
fantastic account connector flow/UX." And on skills: the S3-backed
catalog (0088) is now live (dedicated rustfs sidecar on bee, cn
#125/#126) but the Settings surface is a one-line status string:
"Not configured — set the SKILLS_S3_* environment variables…". The
store deserves a catalog UI: searchable, inspectable, with lifecycle.

Two further inputs:

- **T3 Code (pingdotgg/t3code, MIT)** — studied from source + docs:
  Settings is organized around *providers* (the accounts that power
  the product): one card per provider with status (installed version,
  authenticated, subscription, enabled), a primary connect action,
  alternate auth paths behind a disclosure ("Use a device code
  instead"), secrets stored server-side and never echoed back to
  clients (clients see status shapes only), and multi-account support
  as first-class rows. Their skills surface (composer `$` search)
  shows each skill's *provenance* (System / Personal / Project / App)
  and allows hiding skills from the menu.
- **Skills inventory across apps** (Claude Code, Cursor, T3 Code,
  awesomeskill.ai/skillsdirectory-style marketplaces): the recurring
  pattern is (a) skills as folders with a manifest + body markdown,
  (b) a searchable directory with one-line descriptions — the
  description IS the trigger text, (c) install = copy files into a
  store, (d) enable/disable as the soft lifecycle, delete as the hard
  one, (e) versioning/diff for trust ("what changed since I approved
  this"). Claude Code additionally has a plugins/marketplace flow
  (`/plugin`) — a store URL becomes a browsable catalog you install
  from. Nothing here is hosted-multi-tenant: all are personal
  catalogs.

## Design

### 1. Settings IA — sub-routes, not one page

`/settings` becomes a small section index; each area gets its own
route (matching the app's existing URL-per-surface habit — `/p/<id>`,
`/h/…`, `/sandboxes`):

| Route            | Contents                                                            |
| ---------------- | ------------------------------------------------------------------- |
| `/settings`      | Index: cards/links to the four areas (see §3 for the look)           |
| `/settings/models` | Today's ModelDefaults (providers, default routes, refresh)        |
| `/settings/connections` | Git credentials + the agent-account connectors (§2)            |
| `/settings/skills` | The skills catalog (§4) — not a status line anymore                 |
| `/settings/agent` | AgentSettings (prompt sections) — unchanged, just moved            |

Mobile: the index is a plain list (same NavRow look as the sidebar);
sub-pages use the existing AppHeader crumbs (`Settings / Skills`).
No new dependencies — plain routes.

### 2. Connector cards (T3-style) for every account the app uses

Every external thing sweatshop authenticates as gets the SAME row
anatomy (T3's Providers page pattern), built from existing data —
no new API surface beyond what each card already reads:

```
[icon] GLM (Z.AI)          ✓ key set · 6 models            [Test]
[icon] Gloo                ✓ key set · 5 models            [Test]
[icon] OpenRouter          ✓ key set · 312 models          [Test] [Refresh]
[icon] claude subscription ✓ token set                    [Test]
[icon] cursor              ✓ logged in · expires in 41 days [Test]
[icon] codex (ChatGPT)     ✓ logged in                     [Test] [Log out]
[icon] Git · github.com    ✓ @chad-russell · 2 credentials  [Manage]
[icon] Git · git.crussell.io ✓ @chad · 1 credential         [Manage]
[icon] Skills store (S3)   ✓ connected · 1 skill            [Manage]
```

- Status is a value shape (never a secret echo): "key not set" /
  "logged in · expires in N days" / "connected · N skills". A missing
  credential renders an empty-state card with the ONE next action
  ("Set ZAI_API_KEY in ~/sweatshop/.env.local" — copyable exact
  line), T3-style.
- **[Test]**: new `POST /api/settings/test` taking a connector id
  (`glm` | `gloo` | `openrouter` | `claude` | `cursor` | `codex` |
  `git` | `skills`); server-side cheap live check (one model list /
  one token introspection / one ListObjectsV2). Returns
  `{ok, detail?}` value-shaped. This is the piece that makes the
  page feel alive rather than a settings dump — T3's "refresh
  provider status" is the same idea.
- Row hover → one-line hint under the card ("Used by: chats, titles,
  pi harness calls"), matching SurfaceRow's hint pattern.
- claude/cursor/codex keep their existing connect flows (browser
  OAuth panel, device-code disclosure, paste-auth.json fallback) —
  the card is a frame around flows that already exist; nothing
  about the auth mechanics changes.

### 3. Settings index

Cards in a 2-col grid (md+), each: icon, title, one-liner, and a
status summary line (e.g. Models: "6 defaults configured";
Connections: "8 connected"; Skills: "4 skills"; Agent: "v3 base
instructions"). Row anatomy follows the existing quiet-tool card
grade (border, `rounded-lg`, icon in a tinted square, title +
secondary line, chevron). Semantic tokens only (DESIGN.md); the
status trio (`success` for connected) covers state coloring.

### 4. Skills catalog — `/settings/skills`

The page the store always deserved. Server component reads
`listSkills()` (60 s cache as today); client island handles search
+ actions.

- **Search/filter bar**: `cmdk` (already a dependency) over id +
  description; "N of M" count. Empty state teaches: "Skills are
  agent runbooks saved in your skills store. Ask any chat: 'write a
  skill for …' — you approve every save."
- **Skill rows**: id (mono), description (the trigger text), N
  files, updated-at. Click → detail.
- **Detail view** (`/settings/skills/<id>`): rendered body
  (streamdown, same as chat), file list with per-file viewer,
  front-matter badges (disabled), meta (updatedAt, author), actions
  (§5).
- **Store health**: the §2 skills-connector card sits at the top of
  the page (status + last sync error, if any) — the store being
  down is the ONE empty state this page can't hide.
- **Naming**: the surface says "Skills"; the S3 details stay in the
  card's hint line ("rustfs sidecar on bee · restic nightly").

### 5. Skills lifecycle

Keep 0088's contract: **the agent is the author** (`save_skill`,
approval-gated), the human is the curator. No in-app text editor for
SKILL.md (that was 0054's mistake — deleted for good reason). What
the UI adds is curation + trust, not authorship:

- **Disable/Enable** (v1): `PUT /api/settings/skills/<id>/status`
  toggling front matter `status: disabled` — a store write via the
  existing gateway (`saveSkill` with the same body minus the
  flag). Approval-free: it's the owner acting directly in the UI,
  the same authority `save_skill`'s approval grants.
  Disabled skills show dimmed with a "disabled" badge and stay in
  the list (0088: hiding ≠ deleting).
- **Delete** (v1, confirm dialog): removes the object family from
  the bucket (`S3Gateway.delete` grows on the seam). T3-style
  confirm: what happens, what's kept ("object versions remain in
  the bucket's versioning" — if versioning is on), irreversible
  warning. The live sidecar has versioning ON (per the ops
  runbook), so delete = remove current version; history stays.
- **Version history** (v2, optional phase): list object versions
  (`ListObjectVersions`) → read any prior version → "restore"
  copies it back. This is 0088 §write path's promised revert,
  surfaced. Deferred until v1 proves out.
- **Import** (v2, optional phase): paste/upload a SKILL.md (or zip
  of `<id>/…`), validated by the same `validateSkillInput`, saved
  via the same gateway — the "bring your own" bridge from the
  ecosystem's skill folders. No marketplace, no fetching remote
  URLs in v2 (supply-chain surface; revisit with Chad).

### 6. Agent handoff niceties

- `/settings/skills` empty state links to a prefilled new chat
  (`/?prompt=…` — needs a small `?prompt=` searchParam on `/`,
  passed as the composer's initial text, never auto-sent).
- `use_skill`'s list result and the save-approval card gain the
  skill id as a link to the detail page (transcript cards already
  linkify ids elsewhere).

## Removals

- `components/settings/skills-status-card.tsx` — replaced by the
  connector card + catalog page.
- The `agent` (machines legacy) surface row stays (0031 kept it for
  stored defaults) — unchanged.

## Phases

1. **Settings IA**: sub-routes + index page, content moved verbatim.
   Small, mechanical, screenshot PR.
2. **Connector cards**: the §2 anatomy + `POST /api/settings/test`
   + empty states with copyable env lines. The biggest UX win.
3. **Skills catalog**: `/settings/skills` list + detail + disable/
   enable + delete.
4. **Lifecycle extras** (optional, separate PRs): version history +
  restore; import; `?prompt=` prefill + id links.

Each phase branches `glen/…`, passes the gate, and carries
before/after screenshots (AGENTS.md).

## Verification

- Unit: route map tests; test-endpoint dispatch (fake gateways per
  connector id); skills status toggle writes the front-matter flag
  through the fake gateway; delete removes the family (manifest
  first this time — inverse of the write order); index summaries.
- Mock-model chat tests unchanged (no instruction-path edits).
- Manual: live settings against bee's sidecar (search, disable →
  harness mount drops it, delete → gone, test buttons green).

## Changelog

"Settings is reorganized into Models / Connections / Skills / Agent
with live connector cards (test each connection, see expiries), and
skills get a real catalog page — searchable, with detail views,
enable/disable, and delete."
