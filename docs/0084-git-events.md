# 0084 — Git events into chat: the merge wakes the chat

Status: **draft — awaiting Chad's approval in chat.**

## Why

0052 made the UI honest about PR state (phase chip + PR card poll
`GET /api/x/prs` while open and visible) but explicitly deferred the
agent-side half: "no webhook receiver, no background polling, no
persistence". The cost of that deferral shows in every controller chat:
after opening PRs the agent must end its turn with "just say the word when
the merges are done" — a humanmade sync point in the middle of a
multi-wave plan. `c_zEBWfvnI-6IT6aM5gIZAp` hit it exactly: three PRs
open, chat dead-stops, Chad merges three times in the GitHub UI, types
"all merged", and the chat resumes wave 2. The app holds host credentials
and already knows how to ask (0052's `GitHost.getPRState` seam) — the
missing piece is an event channel from the host into the chat.

## What changes

### `pr_watches` table (new)

One row per PR the app should watch:

| column | notes |
|---|---|
| `id` | text pk — deterministic: `prw_<sha1(owner/repo#number, baseUrl)>[:12]` |
| `conversation_id` | the chat that opened it (create_pr caller) |
| `base_url` / `owner` / `repo` / `number` | resolved at insert |
| `state` | "open" (at registration) → "merged" / "closed" |
| `opened_at` / `settled_at` | integer ms; settled_at null while open |
| `head_sha` | optional; merged-at sha for the wake text |

Deterministic ids make re-watching idempotent (create_pr on an already-
watched PR is a no-op, not a duplicate row), and make the sweep
resumable after crashes without double-waking.

### Registration: `create_pr` (the only writer)

`createPrStep` success inserts/upserts a watch row. That's the entire
write path — no new tool, no model-facing knob, nothing to remember.
PRs opened by hand on the host stay invisible unless the chat asks
(gh/forgejo tools cover asking).

### Polling: the existing wake sweep gains a pass (no new cron/surface)

`instrumentation-node.ts` already runs a 30 s wake sweep
(`WAKE_SWEEP=off` disables). Add `sweepPRWatches()` to the same tick:
query open watches, batch `GET /api/x/prs` (reuse its resolver +
credential scope, cap ~10 per pass), settle transitions. 30 s worst-case
latency to notice a merge — fine: the chat was previously waiting on a
human. `PR_WATCH=off` disables just this pass.

### Delivery: a runEvent wake, exactly like a child settling

On open→merged/closed transition, the watch settles and the conversation
gets a wake message via the existing runEvent path (a user row with
`metadata.runEvent`, rendered as a transcript chip — never Chad's words):
"`#47 merged (chad-russell/sweatshop, 5 files +229/−216) — wave can
proceed`". Waking an idle chat starts a turn (the chat picks up wave 2);
mid-turn it queues as steer. `woken_settled_at` idempotency applies —
the same transition never wakes twice.

Text is capped and cites the watch row; an optional follow-up fetch of
merge details (head sha, title) enriches the text best-effort.

### UI: the phase chip and PR card already update (0052)

The client polls `/api/x/prs` while the tab is open; the sweep now feeds
the same `pr_watches.state` back into that route's answer (settled
watches answer from the row, no host fetch) and phase chips settle
without a host fetch too.

## Decisions & alternatives

- **Poll, not webhooks.** bee is internal; a receiver means an exposed
  route, a shared secret, and replay semantics for zero latency benefit —
  the previous sync point was a human. Revisit only if watch counts grow
  into the hundreds.
- **create_pr-only registration.** The alternative — a generic
  `watch_pr` tool — puts host-event plumbing on the model's plate and
  invites watching arbitrary PRs (rate limits, noise). The chat that
  opened the PR is the chat that needs the event; anything else is the
  gh/forgejo tools' job.
- **Reusing the wake sweep tick.** A second interval is a second thing
  to monitor; the 30 s sweep is already the app's "async settles" loop
  and the pass is cheap (≤10 API calls per 30 s worst case).
- **No new tools for the model.** The event arrives; the chat reacts.
  Keeping the model out of the registration loop is the feature.

## Testing

- Registration: create_pr success upserts the deterministic row; denial
  path writes nothing.
- Sweep: open→merged settles + wakes once (idempotent under double
  sweep); open→closed wakes with closed text; host null (unknown) never
  settles; batch cap respected; `PR_WATCH=off` skips the pass.
- Wake delivery: idle conversation starts a turn; live conversation
  queues steer (existing wake tests cover the path — one new fixture for
  the PR runEvent chip text).
- Gate green.

## Rollout

Single PR, additive table + sweep pass + create_pr hook. Default-on
(cheap, bounded); `PR_WATCH=off` is the brake. AGENTS.md wake bullet
gains one sentence; 0052's "deferred" note points here.
