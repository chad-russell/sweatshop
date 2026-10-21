# 0057 — Gloo prompt caching

Status: **approved in chat, 2026-10-20** — enable caching and capture its
read/write charges; no dependency or endpoint changes.

## Contract

- Gloo Anthropic routes opt in with `X-Cache-TTL: 5m`, for chat/title
  models (including effort-configured instances) and pi. Other routes
  retain their existing implicit caching behavior. No pre-warm calls.
- Gloo owns the system-prefix breakpoint. This change does not inject
  conversation-history breakpoints or promise that all input is cached.
- Normalize Gloo's OpenAI usage fields and Anthropic aliases at the
  provider boundary, before the Workflow SDK records usage. Prompt tokens
  use the OpenAI-compatible inclusive total; read/write are disjoint subsets.
  Prefer standard fields when present, including explicit zero values.
- Persist cache writes separately from reads. Cache hit percentage remains
  reads / total input, never writes / input. Show writes in the model detail.
- Cost = fresh × input + reads × cache-read + writes × cache-write +
  output × output, multiplied by the platform fee. Use the five-minute
  write rate, including long-context tiers; absent write prices fall back
  to ordinary input pricing, not free input.
- Keep the existing guarded legacy alias. Gloo now documents it as guarded
  (6.5% fee), so newly refreshed Gloo prices use 1.065; manual overrides
  still win. Existing event costs are not rewritten.
- Migration adds a zero-default cache-write count. No historical backfill;
  existing workflows without the new optional count remain valid.

## Evidence and verification

Gloo docs: [prompt caching](https://docs.gloo.com/api-guides/prompt-caching),
[endpoint aliases](https://docs.gloo.com/api-guides/endpoint-types#legacy-endpoint-aliases),
and [wire usage](https://docs.gloo.com/api-guides/direct-completions).
Installed `@ai-sdk/openai-compatible` 3.0.59 exposes `convertUsage` and
preserves loose wire usage fields; pi 0.85.1 reads standard cache read/write
fields and accepts provider headers. No package patch is needed.

Mock HTTP tests cover headers, effort composition, streamed/non-streamed
usage and aliases; pure/store/workflow tests cover normalization, writes,
rates, migration and rollups. The normal gate never calls a real model.
