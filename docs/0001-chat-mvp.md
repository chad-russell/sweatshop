# 0001 — Chat MVP

Status: **shipped** (2026-09-29) — see Verification below.

## Goal

A functional eve project: one Next.js page with an AI Elements chatbox,
backed by a single eve agent on the Z.AI GLM coding plan. The smallest
honest version of sweatshop — right foundations, zero bolted-on features.

## Non-goals (explicitly out of scope)

- Session history list / sidebar. Eve sessions are durable; a UI list is a
  later feature.
- Model picker. First expansion *after* this lands; the MVP keeps a single
  static model so the picker has a clean seam to grow into.
- App-level SQLite. Deferred until a feature needs persistence beyond eve's
  own session durability.
- Agent tools, skills, subagents, sandbox, schedules.
- Any deployment beyond the local dev container.

## Decisions

| Decision          | Choice                                                                                          | Why                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| App shape         | Single Next.js App Router app at repo root; `agent/` beside app code; `withEve()` in next.config | One dev command, one container, simplest correct thing                               |
| Transport         | `useEveAgent()` from `eve/react`; no `/api/chat` route                                          | eve owns sessions, streaming, durability                                             |
| Model             | `zhipu-ai-provider` → `glm-5.3-flash`; `ZAI_API_KEY`; coding-plan endpoint                       | Exact wiring verified working in the prototype                                       |
| Channel auth      | `agent/channels/eve.ts` with `none()` → synthetic principal                                     | LAN-only personal tool; AGENTS.md hard rule to replace before internet exposure       |
| UI kit            | Vercel AI Elements components on shadcn + tailwind v4                                           | Project direction; vendored skills support it                                        |
| Theme             | DESIGN.md contract from day one: `clickhouse` default, `cal`, `nova`; next-themes persistence   | The design system was the good part of the prototype; retrofitting themes is costlier |
| Dev environment   | podman single container: `node:24-trixie-slim`, bind-mount + named node_modules volume           | Host stays clean; environments spin up/down trivially                                |
| Package manager   | npm                                                                                             | eve's default; one less variable                                                     |
| Tests             | None yet; `npm run typecheck` + `npm run lint` gate every commit                                | Agreed quality bar; mock LLM arrives with the first test suite                       |

## Resulting layout

```text
sweatshop/
├── AGENTS.md, DESIGN.md, skills-lock.json
├── .agents/skills/          # vendored: eve, ai-sdk, ai-elements
├── design/                  # prototype design references (read-only inputs)
├── docs/                    # numbered design docs (this file)
├── dev                      # podman wrapper script
├── .env.example             # ZAI_API_KEY template (committed)
├── .env.local               # real key (gitignored)
├── package.json             # npm scripts: dev, build, start, lint, typecheck
├── next.config.ts           # withEve()
├── agent/
│   ├── instructions.md      # the agent's identity/behavior prompt
│   ├── agent.ts             # defineAgent: static glm-5.3-flash LanguageModel
│   └── channels/eve.ts      # none() auth → synthetic sweatshop-ui principal
├── app/                     # App Router: single page
│   ├── layout.tsx           # next-themes provider
│   ├── page.tsx             # the chat page
│   └── globals.css          # tailwind v4 + three themes' token sets
├── components/              # shadcn/AI Elements components + chat composition
└── lib/                     # utils.ts (cn) — grows only when needed
```

## The dev container

One container, no compose (graduate when a second service appears):

- Image `docker.io/library/node:24-trixie-slim` (major pinned).
- Repo bind-mounted rw at `/workspace` (live reload); named volume
  `sweatshop-node-modules` mounted at `/workspace/node_modules` so the host
  tree never contains dependencies.
- `--user 0:0` (rootless root maps to the host user — same ownership
  outcome as keep-id, which hits a crun bug on bee), `--env-file
  .env.local`, `-p 3300:3000` (host 3000 is occupied by an unrelated
  service), `--init`.
- `withEve()` boots the eve dev server inside the container alongside
  `next dev`; the browser only ever sees the Next.js origin.

### `./dev` wrapper surface

```text
./dev              # npm install if needed, then npm run dev (attached)
./dev install      # npm install inside the container
./dev exec -- CMD  # one-off CMD in a fresh container with the same mounts
./dev shell        # interactive shell in the dev container
./dev clean        # remove the dev container (node_modules volume survives)
```

`./dev exec` is also the sanctioned way to read eve's bundled docs
(`./dev exec -- cat node_modules/eve/docs/README.md`).

## Build plan (commit sequence)

Each step ends with typecheck + lint green, committed separately:

1. `chore: repo scaffold` — commit what already exists (vendored skills,
   DESIGN.md, design/ references).
2. `docs: AGENTS.md + 0001 chat MVP design` — this document.
3. `feat(dev): podman dev container + ./dev wrapper` — `dev` script,
   `.env.example`, `.gitignore`.
4. `feat(web): next.js + tailwind v4 + shadcn + theme tokens` — app shell,
   `globals.css` with the three themes' token sets, theme toggle,
   typecheck/lint scripts wired.
5. `feat(agent): eve agent with GLM wiring + LAN channel` — `agent/`
   contents, `.env.local` consumed by the eve dev server.
6. `feat(web): chat page` — AI Elements conversation/message/prompt-input
   wired to `useEveAgent`; New-chat affordance (reset + fresh durable
   session); session cursor persisted to localStorage with `resume: true`
   on mount so a reload continues the durable conversation.
7. `docs: 0001 verification notes` — mark approved/shipped with a manual
   test transcript.

## Verification (2026-09-29)

What was verified, and how:

- **Container workflow** — `./dev exec`, `./dev install`, and `./dev`
  (attached dev server) all run from the repo with nothing installed on
  the host; container-root writes land `crussell`-owned; fresh-volume
  `npm install` completes in ~32s. Two deviations from the plan, both
  documented in the wrapper: `--userns=keep-id` hits a crun
  empty-readlink bug on bee, so the container runs as root under
  rootless podman's default uid map (same ownership outcome); and the
  host port is **3300**, not 3000 — host 3000 is occupied by an
  unrelated next-server (`SWEATSHOP_PORT` overrides).
- **eve agent end to end** — `GET /eve/v1/health` → 200
  `{"ok":true,"status":"ready"}`; a session created with a message via
  `POST /eve/v1/session` streamed real GLM output to
  `message.completed` / `step.completed` (usage reported) and parked at
  `session.waiting`; `POST .../reset` retires the session. `.env.local`
  is picked up by the eve dev server via `--env-file`.
- **Chat page** — `GET /` renders the AI Elements surface (empty state +
  composer) with all three themes compiled into the CSS
  (`#faff69`/`#111`/nova); our TSX is token-pure (raw values only in
  `globals.css` token definitions). The page drives the same `/eve/v1`
  transport through `useEveAgent` that the curl proof exercised.
- **Quality gates** — `npm run typecheck` and `npm run lint` clean in
  the container at every commit. Registry-vendored components
  (`components/ai-elements`, `components/ui`) and skill demos
  (`.agents/`) are excluded from lint as tool-managed code, matching the
  prototype's practice.

Click-through items for Chad (curl can't cover the browser): send a
message from the composer and watch it stream; reload mid- and
post-conversation to see the durable session resume from localStorage;
New chat starts a fresh session; the palette button cycles
clickhouse → cal → nova and persists across reloads.

## Definition-of-done mapping

| Check                                                              | Result |
| ------------------------------------------------------------------ | ------ |
| `./dev` brings the app up with zero host installs                  | ✅     |
| Chat round-trip streams a real reply from `glm-5.3-flash`          | ✅ curl-verified; UI uses the same route |
| Reload resumes the durable session; New chat starts fresh          | ✅ server replay verified; localStorage path follows the documented `initialEvents`/`initialSession`/`resume` pattern — click-through pending |
| Themes switch and persist; no raw hex/oklch in TSX                 | ✅ compiled CSS + grep |
| `npm run typecheck` and `npm run lint` clean inside the container  | ✅     |

## Deviations from plan

- Host port 3300 instead of 3000 (host port occupied) — `SWEATSHOP_PORT`
  overrides.
- `--user 0:0` instead of `--userns=keep-id` (crun bug on bee).
- `loader` component doesn't exist in the ai-elements registry; the
  thinking indicator uses the shadcn `Spinner` primitive instead.
- AI Elements components arrived via `npx ai-elements add` (idiomatic
  path) rather than copying the prototype's vendored files.

## Risks / notes

- **Version alignment** — AI Elements' `ai` / `@ai-sdk/react` peer range vs
  eve's pinned `ai`: resolve by deduping onto eve's line; escalate to
  overrides only if peers conflict.
- **zhipu-ai-provider + ai v7** — the prototype ran this combo on eve
  0.67.x successfully; pin near those versions.
- **First boot cost** — initial `npm install` inside the container is slow;
  the named volume makes it once.
- **GLM flash limits** — 128k context on the coding plan; fine for chat,
  compaction handles long sessions.
