# Models and routes — who thinks what

Providers are code; keys are env on the server. GLM (Z.AI coding
plan), gloo, and OpenRouter are the providers — a provider
without a key is simply unavailable. claude is a subscription harness,
not provider-routed.

## Routes

A route picks the model per surface: `{provider, model}` for chats
and agent stages; `{harness: "pi" | "claude", …}` for harness stages.
Resolution: run override > run stage > machine stage > project
default > global default (claude never inherits chat/project routes).
Project restrictions apply on top — a route the project forbids is
rejected, never swapped.

Where the owner sets them: the chat's route picker (per conversation),
`/settings` (global defaults), the project page Models card (project
defaults), the run view (per-visit), and machine stage definitions.

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
strong models for implementation and review, cheaper models for
claude for deep refactors. `start_machine`'s `overrides` argument and
the route pickers change models without editing machines.
