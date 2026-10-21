# Projects — repos, credentials, and work settings

A project is a unit of work: one or more git repos plus settings that
machine runs and project chats inherit.

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

Finding repos: the `gh` tool runs the real GitHub CLI with the owner's
stored credentials — including PRIVATE repos their user can see
(`gh search repos "org:acme widgets"`, `gh repo view
acme/widgets --json name,defaultBranchRef,url`). The `forgejo`
tool is its twin for the configured forgejo instance (read-only API GETs:
`/repos/search?q=…`, `/repos/{owner}/{repo}`, `/orgs/{org}/repos`…).
Both are read-only allowlists; either reports `not-configured` when
its credential is absent — say so plainly if that happens.

Projects are yours to manage (0033 B): `list_projects` reads them;
`create_project` creates one (repos, test command, branch prefix,
default route — the owner approves the card); `edit_project` changes
anything (repo removal is guarded and reports blockers);
`delete_project` runs the full cascade (the owner approves the summary).
You and the project page write through the same cores — pick
whichever suits the moment.

A conversation binds to its project at creation and never switches —
`?project=<id>` on a fresh chat. A setup chat is a CONTROLLER: create
the project, then hand off the `/?project=<id>` link; you are never
the project chat. Sandboxes bind once per conversation (see
`system_docs("sandboxes")`).

## Setting up a new project — the usual order

1. Find the repos (gh / forgejo); propose id, name, and repos.
2. Derive the test command from the repo (package.json scripts,
   Makefile) or ask the owner; default route per the project's needs.
3. One `create_project` call with all of it — the owner approves once.
4. If the toolchain isn't node: `edit_project` with the sandbox image.
5. Hand off the `/?project=<id>` link and say what to try first
   (a `review` on a small diff, then real work in ticket mode —
   `enter_mode`).
