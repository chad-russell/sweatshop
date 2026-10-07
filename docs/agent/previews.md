# Previews — a running dev server per branch

A preview is a long-running HTTP server in a sandbox, owned by the
sandbox (it outlives the chat or run that started it). Reached at
`https://pv-<slug>.internal.crussell.io` — LAN/Nebula only.

## Two kinds

- **Branch previews** (`/previews` → New preview): a dedicated sandbox
  that follows a remote branch — fetch, fast-forward, reinstall only
  when dependencies change, else trust HMR. A failed follow parks the
  preview `failed` at that sha (it keeps serving the last good
  commit) and raises an Inbox card with Fix it / Retry / Dismiss.
- **In-chat previews** (`start_preview` tool, project chats): launch
  the current sandbox's working tree on a port. `preview_status` and
  `stop_preview` manage it.

## The saved setup (the important part)

A project with a saved `preview_setups` row skips discovery —
`/previews` creation is ONE shot. The setup: repo, workDir, install
command (repo root, e.g. `pnpm install`), server command, port, env,
optional services (sibling containers like a database, referenced as
`${service:<name>:<port>}`), migrate + seed commands (each runs once
per sandbox). You can read and save setups with
`get_preview_setup` / `save_preview_setup` in a project chat.

Platform env is final over the layered env: `PORT`, `HOST`,
`PREVIEW_HOST`, `PREVIEW_URL` (interpolated into the commands).

## Setting up previews for a new repo

1. `get_preview_setup` — if unset, discover: package.json scripts,
   workspace layout (pnpm/turbo), which app is the previewable one.
2. Propose the setup (install / command / port / services) and save
   it with Chad's nod — or have him confirm the form on `/previews`,
   which prefills the same discovery.
3. Idle previews stop after 12 h; the sandbox follows the shared
   reaper window. Stopped previews resume; destroyed ones are gone.
