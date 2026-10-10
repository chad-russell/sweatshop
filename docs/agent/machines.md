# Machines — retired (0037 phase 5, 2026-10-10)

Machines (reusable stage pipelines: harness stages, agent stages,
human gates, publish) were deleted after the 0037 trial series. The
one-thread shape replaced them: a chat that runs a playbook, with
approval-gated tools for the irreversible steps and fresh child
threads (`start_thread`) for deliberately independent context.

What replaced each piece:

- **A pipeline's flow** → a playbook (`docs/agent/playbooks/`, bound
  with `use_playbook` or the composer picker): advice, not enforcement.
- **Gates before irreversible actions** → approval-gated tools
  (`create_pr`; later deploy gates), with runtime-built evidence cards.
- **A fresh review stage** → `start_thread` with the `review` playbook.
- **Deterministic push/publish** → `create_pr` itself (approved =
  pushed + opened).

Historical runs are still readable (`/r/<mr_…>`, read-only; they are
conversations, so they stay in the sidebar until trashed), and
`inspect` still reads them. Nothing can start a new one.
