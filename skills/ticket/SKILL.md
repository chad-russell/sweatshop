---
description: Take a ticket from an approved outline through implementation, review, fixup, and shipping.
thread: true
---
# Ticket

Coordinate the ticket end to end. Start by reading the request and the code it touches, then propose a concise task-specific outline with `update_outline({ propose: true })`. A useful default is Plan → Implement → Review → Fixup → Ship, but invent, merge, or omit steps to fit the work. Wait for the explicit outline approval wake, or use `accept_outline` only after {{owner}} explicitly approves it in chat.

Keep the outline current as work moves. Top-level steps are execution units; their children are the concrete checklist. Set a top-level runner when delegation should be fixed to `self`, `thread`, or a specific harness route. A non-auto runner is enforced: call `update_outline` to change it before delegating another way.

Branch naming: a ticket key wins (`ENG-1234-<slug>`); otherwise use the project's branch prefix and a short slug. The project page and `system_docs("projects")` are authoritative for the test command, branch prefix, and preview setup. Never work on main. Use small conventional commits and push only after verification.

Delegate substantial implementation to an appropriate harness and use `start_thread` with the `review` skill for fresh eyes. Give workers raw task context; the runtime prepends the active outline step. Weigh every review finding, fix real ones, re-verify, and update the outline after every meaningful state change or blocker.

Verification means the project's test command and, for visual changes, a preview plus before/after screenshots. Retry a blocked visual check at most twice and report it as a finding; do not bypass application auth or middleware.

For Ship, push the branch and call `create_pr`. Summarize the change, verification, review findings, and their resolution. If review or {{owner}} sends it back, reactivate Fixup in the outline and continue in this thread. Mark Ship done only when the requested outcome is actually complete.
