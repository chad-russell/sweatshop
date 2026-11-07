# 0091 — Skills: federated search, explicit attach, invocation control

Status: **draft 1, 2026-10-31 — awaiting Chad's approval before implementation.**
Grows docs/0090 (§7 sources, §6 handoffs); supersedes nothing.

## Why

Chad (2026-10-31, after 0090's four phases landed): three follow-ups.

1. **"What other public repos?" + "a search that scrapes or searches all
   the popular skill banks"** — 0090 §7 shipped one curated source
   (anthropics/skills). Research since (verified live 2026-10-31):
   - **SkillsMP** (`skillsmp.com`) is the discovery layer that exists
     today: a public, unauthenticated search API
     (`GET /api/v1/skills/search?q=…`, 20/page) whose rows carry
     `githubUrl` → `owner/repo/tree/<ref>/<path>` — exactly our install
     machinery's input. It indexes 425k+ skills across many banks
     (openclaw, mattpocock, …). It serves NO content — a directory of
     GitHub repos; we still fetch from GitHub at a pinned sha.
   - Real folder-repos worth naming as SOURCES: `obra/superpowers`
     (15 skills, verified), `openclaw/openclaw` (50, verified). The
     "awesome-agent-skills" lists are README link farms (zero
     SKILL.md folders) — not sources.
   - GitHub code search (`filename:SKILL.md`) is authenticated-only,
     rate-limited to 10 req/min, and flaky for path queries — the
     wrong backend. SkillsMP + named sources is the right shape.
2. **"Better UX for controlling how and when the agent uses a skill"** —
   today every active skill rides the instructions appendix of every
   turn (progressive disclosure via `use_skill`). That is implicit
   model-side selection; nothing lets Chad force or forbid one.
3. **"Attach skills in the `+` menu like photos"** — the composer's
   `+` (PromptInputActionMenu, 0042) gains an "Add skill" action
   choosing from the local catalog.

## Design

### 1. Sources registry grows + SkillsMP search (§7 extension)

- `SOURCES` adds `obra/superpowers` (path `skills/`) and
  `openclaw/openclaw` (path `skills/`) — same browse path as
  anthropics (one git-trees call each, 10-min cache).
- NEW **federated search** in `lib/skills/catalog-source.ts`:
  `searchCatalogs(query)` — SkillsMP search (up to 2 pages, 40 rows,
  10s timeout, cached 5 min per query) mapped to
  `CatalogEntry + { repo }`; each row's install target derives from
  its `githubUrl` (`owner/repo/ref/path` — pin to the repo's CURRENT
  head sha at install time, recorded in the manifest). SkillsMP rows
  carry a `stars` signal — shown, not trusted.
- The catalog tab becomes **Search**-first: one box queries SkillsMP;
  the SOURCES segmented control stays (browse is still one git-trees
  call away, now three sources). Results rows show
  `name · author · ★stars` with the same preview → install flow
  (preview fetches from GitHub at head, install pins that sha).
  SkillsMP itself is never a content source — untrusted directory,
  immutable source, same trust rule as 0090 §7.
- Registry stays code (no UI for adding sources in this doc).

### 2. Invocation modes — per skill (the control Chad asked for)

Every skill gains an invocation mode in front matter:
`invoke: auto | tool | manual` (default `auto`).

- **auto** (today's behavior): appendix line + `use_skill` on demand.
- **tool**: NO appendix line — the skill is invisible in instructions;
  it only exists as a tool capability. Concretely: `use_skill`'s list
  result marks it `tool-only`, and harness mounts INCLUDE it (the
  harness CLI's own skill mechanism is exactly this shape — Claude
  Code/Codex materialize it in `~/.agents/skills` and the model
  invokes when it chooses). In-chat, a tool-mode skill's description
  joins a compact `# Tool skills` appendix line so the model knows the
  capability exists without the full description competing for
  context: `tool: pdf — document tooling (mounted in harnesses)`.
- **manual**: NEVER auto-invoked. Not in appendix, not harness-mounted.
  It exists only for explicit attach (§3) and `use_skill` by id. This
  is the "I want it only when I say so" mode.

The mode is edited the same honest way as `status: disabled` —
`setSkillInvokeMode(id, mode)` store seam (front-matter line surgery,
same write path), surfaced as a three-way segmented control on the
skill detail page (and the disable/delete row stays). The catalog UI
rows show a mode chip. `save_skill`'s front matter accepts
`invoke:` too (agent-authored skills get the same control).

### 3. Attach skills to a prompt (the `+` menu)

The composer's `+` menu (PromptInputActionMenu, 0042) gains
**"Add skill…"**:

- Opens a small picker (Command palette shape, cmdk — already a dep)
  listing attachable skills: manual- and tool-mode skills FIRST
  (they can ONLY join by attach), then auto ones (attach = one-turn
  override that doesn't touch their global mode).
- Choosing one appends a **skill chip** to the composer's attachment
  row (the same visual row as image thumbnails — an attachment
  without bytes): `📚 pdf` with an X to remove.
- On send: attached skills are injected as an
  `# Attached skills` section in the turn's instructions — the full
  body inlined (attach is explicit intent; the model gets the whole
  runbook, no `use_skill` round-trip needed), listed by id with
  description headers. Attached skills do NOT double-list in the
  appendix.
- Harness calls inherit attached skills through the existing mount
  path (they're already in the catalog; mounting is unchanged — the
  attachment shapes the CHAT's instructions, the harness mount
  follows the store).
- Removal before send = un-chip. There is no per-message detach
  after send (the instruction join is turn-scoped by construction —
  `attachments` ride the send request, not the conversation).

## Removals

None. `skills-status-card` is long gone; nothing else dies.

## Phases

1. **Sources + federated search**: SOURCES grows (superpowers,
   openclaw), `searchCatalogs` via SkillsMP, Search-first catalog tab.
2. **Invocation modes**: front-matter `invoke:`, store seam, detail
   segmented control, appendix/tool/mount behavior splits.
3. **Attach skills**: `+` menu action, picker, chips, send-path
   instruction join, tests for the instruction assembly.

## Verification

- Unit: search mapping (githubUrl parse, 2-page merge, cache, StarsMP
  error → value shape), sources browse for the two new repos (fake
  trees), invoke-mode surgery (byte-except-line, like 0090 phase 3),
  appendix splits (auto/tool/manual), instruction join for attached
  skills (mock-model chat test asserting the `# Attached skills`
  section appears and appendix de-dupes).
- Live smoke: search "pdf" through the app; install a SkillsMP row;
   attach a manual skill and confirm the harness mount excludes it
   while the attached turn's instructions include it.

## Changelog

"Skills get a real discovery search (SkillsMP across the public skill
banks, plus obra/superpowers and openclaw as browsable sources),
per-skill invocation control (auto / tool-only / manual), and you can
attach a skill to a prompt straight from the composer's + menu."
