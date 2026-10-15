# Hosts — the exec tool and the per-project allow-list

A project can list **hosts** — real machines its agent may operate on
over SSH. The list is an allow-list: nothing outside it is reachable,
and a project with no hosts simply has no `exec` tool.

## What exec does

`exec(host, command, timeout?)` runs a bash command (`bash -lc`) on the
named host, as the host's configured user:

- **Every call asks Chad first.** The approval card shows the host and
  the exact command; his Approve runs it, typing in the thread denies
  it (the text goes back to the model as the reason).
- The default timeout is 120 s (max 900). A timeout cuts the channel
  and returns partial output — the command may still be running on the
  host, so check before repeating it. Longer jobs should run detached
  with the log polled (e.g. `systemd-run`, `nohup … && tail`).
- Output is clipped (60 k characters each stream). Exit code, stdout,
  stderr, and duration come back as the tool result.
- Every approved call is audited (`host_commands`): written before the
  run, resolved after — a crash mid-command still shows the attempt.
  `inspect` on the conversation lists recent host commands.

## Credentials

The app's environment is the registry, keyed by host NAME (uppercased,
non-alphanumerics → `_`), global across projects:

```
HOST_<NAME>_SSH_KEY_FILE       path to a 0600 private key (preferred)
HOST_<NAME>_SSH_KEY_PASSPHRASE optional passphrase for that key
HOST_<NAME>_SSH_PASSWORD       inline password (password-only hosts)
```

Credentials never enter sqlite, the browser, or any sandbox — the SSH
channel is opened by the app process; sandboxed code has no route to a
host. Adding or rotating a credential is an env edit plus a service
restart.

## Host keys

TOFU: the first successful connect pins the host key's fingerprint on
the host row (the audit row notes the pinning). Every later connect
must match — a mismatch is a hard `host-key-changed` refusal, never a
prompt or a silent accept.

## Working on hosts well

- Read the host's own docs first — the project's repos carry them
  (cn's AGENTS.md has the SSH notes and the lockout rules; the
  homeassistant README has the add-on mechanics). Lockout-sensitive
  services (sshd, networking, nebula, gateway caddy) get extra care by
  the repo's own rules.
- Secrets: reference PATHS, never contents —
  `curl -H "Authorization: Bearer $(cat /path/to/token)"`. API calls run
  as `exec` + curl on a host that holds the credential file.
- Verify what you changed (`systemctl is-active`, `journalctl` tails,
  curl the service) — report what you saw, not what you assume.
