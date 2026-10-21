-- Forward-only: old event costs remain unchanged.
ALTER TABLE usage_events ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
