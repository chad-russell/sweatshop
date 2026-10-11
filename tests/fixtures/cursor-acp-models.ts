/**
 * The model ids Cursor's ACP server (`agent acp`, `session/new` →
 * `models.availableModels`) accepted on 2026-10-11 (CLI 2026.10.01). ACP's
 * vocabulary is NOT the one `agent --list-models` prints: ACP has base ids
 * ("gpt-5.6-sol", "auto-smart") with effort / context / speed as separate
 * options, while --list-models prints composed ids ("gpt-5.6-sol-high",
 * "auto"). The adapter passes the route's model straight to ACP's `model`
 * option, so any id outside this set fails the turn "Invalid params".
 *
 * Refresh with the probe in docs/0038 ("Model ids") when Cursor changes it.
 */
export const CURSOR_ACP_MODEL_IDS: readonly string[] = [
  "auto-smart", "grok-4.7", "grok-4.6", "composer-2.5", "claude-opus-5-5", "claude-opus-5",
  "claude-opus-4-8", "gpt-5.6-sol", "gpt-5.5", "claude-fable-5-1", "claude-fable-5", "grok-4.5",
  "gemini-3.8-flash", "gemini-3.7-flash", "muse-spark-1.3", "gpt-5.6-terra", "claude-sonnet-5-5",
  "claude-sonnet-5", "claude-sonnet-4-6", "gpt-5.3-codex", "claude-opus-4-7", "gpt-5.4",
  "claude-opus-4-6", "claude-opus-4-5", "gpt-5.2", "gpt-5.6-luna", "gemini-3.6-flash",
  "gemini-3.1-pro", "gpt-5.4-mini", "gpt-5.4-nano", "claude-haiku-5-5", "claude-haiku-4-5",
  "claude-sonnet-4-5", "gpt-5.1", "gemini-3-flash", "gemini-3.5-flash", "claude-sonnet-4",
  "gpt-5-mini", "gemini-2.5-flash", "kimi-k3", "kimi-k2.7-code", "glm-5.2", "glm-5p3", "glm-5p3-flash",
];
