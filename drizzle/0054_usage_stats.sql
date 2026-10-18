-- 0047 usage & cost stats: metering what a ticket costs. Two tables:
-- usage_events (one row per metered unit: a chat turn or a harness call,
-- written at settle time by the turn's final persist / the call's settle
-- step) and model_prices (per-model per-1M rates refreshed by the catalog
-- lazy path; gloo needs no key). Cost is computed at capture time with the
-- then-current price row — price drift never rewrites history.

CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  harness_call_id TEXT,
  route TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER,
  steps INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX usage_events_conversation_idx ON usage_events(conversation_id);
--> statement-breakpoint
CREATE TABLE model_prices (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_per_m REAL NOT NULL,
  output_per_m REAL NOT NULL,
  cache_read_per_m REAL,
  cache_write_per_m REAL,
  long_context TEXT,
  platform_fee REAL NOT NULL DEFAULT 1.0,
  source TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model)
);
