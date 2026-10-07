# Projects — repos, credentials, and work settings

A project is a unit of work: one or more git repos plus settings that
machine runs and project chats inherit. GPL, open-bible, sweatshop
itself are (or will be) projects.

## What's on a project

- **Repos** — cloned into every project sandbox under
  `/work/<runOrConversationId>/<repo-name>`. Credentials resolve
  automatically by git host (github, forgejo) from the stored
  credential — private repos just work.
- **Models** (`/p/<id>` → Models) — the project's default route for
  chats, agent stages, and pi; may restrict allowed providers/harnesses.
  Employer projects typically default to gloo.
- **Sandbox image** — unset means the standard node image
  (`localhost/sweatshop-sandbox`); nix/rust projects need a custom
  image (see `system_docs("sandboxes")`).
- **Work defaults** — the test command (what verify stages run; e.g.
  `npm run typecheck && npm run test`) and the branch prefix
  (machine branches land as `<prefix>/<slug>`; unset means generic
  `<type>/<slug>`, and a ticket key like `ENG-1234` in the run prompt
  always wins — that's the Linear path).
- **Preview setup** — the saved launch recipe so `/previews` creation
  is one shot (see `system_docs("previews")`).

## Who does what

Finding repos: the `gh` tool runs the real GitHub CLI with Chad's
stored credentials — including PRIVATE repos his user can see
(`gh search repos "org:TangoGroup gpl"`, `gh repo view
TangoGroup/360-gpl --json name,defaultBranchRef,url`). The `forgejo`
tool is its twin for the self-hosted instance (read-only API GETs:
`/repos/search?q=…`, `/repos/{owner}/{repo}`, `/orgs/{org}/repos`…).
Both are read-only allowlists; either reports `not-configured` when
its credential is absent — say so plainly if that happens.

Creating projects still needs Chad today (the projects list → new
project; 0033 Phase B will give you the tool). Once it exists with
repos, drive everything else: start chats and machines against it,
inspect runs, and tell Chad exactly which fields to fill (test
command, models, image) when a setup gap bites.

A conversation binds to its project at creation and never switches —
`?project=<id>` on a fresh chat. A setup chat is a CONTROLLER: help
create the project, then hand off the `/?project=<id>` link; you are
never the project chat. Sandboxes bind once per conversation (see
`system_docs("sandboxes")`).

## Setting up a new project — the usual order

1. Chad creates the project and adds its repos (UI, one form).
2. Chad sets the Models default (employer work: a gloo model).
3. Ask Chad for the test command, or derive it from the repo
   (package.json scripts, Makefile) and have him paste it into Work
   defaults.
4. If the toolchain isn't node: sandbox image (Chad, UI).
5. Prove the loop: run `review` on a small diff, then a real `ticket`.
