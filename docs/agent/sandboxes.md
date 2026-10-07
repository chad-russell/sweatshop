# Sandboxes — where the work runs

Every project chat and machine run works in a sandbox: a podman
container (sibling of the app, on the private `sweatshop-harness`
network) with the project's repos cloned under `/work/<id>/<repo>`.

## Bindings — the one rule

A conversation's sandbox is chosen ONCE, by the send that creates it:
its own (created lazily on the first sandboxed call), none, or
attached (a copy of another conversation's binding — same sandbox,
same directory). It never switches — start a new chat to change
sandboxes. A machine run inherits the starting chat's sandbox and
directory (`fresh: true` in `start_machine` opts out with a new one).

## Lifecycle

- Sandboxes outlive their runs and chats — finished work stays
  inspectable and attachable.
- The reaper stops idle sandboxes after 30 min and destroys them after
  7 days — never one with live work (a running harness call or
  preview keeps it busy). Stopped sandboxes resume; destroyed ones
  are gone (their rows stay as history).
- Manual Stop/Destroy is on each sandbox page (`/sandboxes/<id>`).

## Your tools

- `bash` — run a command in THIS conversation's sandbox, its working
  directory (project chats only).
- `pi` / `claude` — hand a coding task to a harness, in the
  background, same sandbox; the chat is woken with the result. pi
  keeps context across calls; claude is the deep-refactor pick.
- `inspect` — read-only look at any chat, run, or sandbox: status,
  transcript tail, harness activity, binding.
- `sandbox_exec` — one command in ANOTHER chat's or run's sandbox
  (resumes a stopped one; never stops or destroys).

## Images

Unset = `localhost/sweatshop-sandbox` (node 24 + git + docker-cli).
A project can pin any image ref (nix, rust, flutter) on its page —
the image must exist in bee's podman or be pullable. Verify the
toolchain with `bash` (e.g. `node --version`, `nix --version`)
before starting work that depends on it.
