# Models and routes — who thinks what

Providers are code; keys are env on the server. GLM (Z.AI coding
plan), gloo, and OpenRouter are the providers — a provider
without a key is simply unavailable. claude is a subscription harness,
not provider-routed.

## Routes

A route picks the model per surface: `{provider, model}` for chats
and agent stages; `{harness: "pi" | "claude" | "cursor" | "codex", …}`
for harness stages. Resolution for chats: conversation > project >
global (pi inherits the conversation's route); the subscription
harnesses are global-only and never inherit chat/project routes.
Project restrictions apply on top — a route the project forbids is
rejected, never swapped.

Where the owner sets them: the chat's route picker (per conversation),
`/settings` (global defaults), and the project page Models card
(project defaults).

## What this means in practice

- **Chats** follow the conversation's route, else the project's,
  else the global default (derived from the available provider keys —
  GLM `glm-5.3-flash` when GLM is configured).
- **What ran is recorded** — each stage run and the turn's first
  assistant message carry the resolved route and which layer chose
  it; `inspect` shows it.
- A route that cannot run (missing key, forbidden provider) fails the
  stage or turn loudly with the reason — report that verbatim rather
  than retrying.

## Choosing for the owner

Suggest routes by task: flash-class models for mechanical steps,
strong models for implementation and review, claude/cursor/codex for
their subscription strengths. The route pickers change models without
touching code.
