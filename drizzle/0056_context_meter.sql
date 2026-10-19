-- 0051 context meter: the turn's LAST slice's token counts. The last
-- slice's input re-sent the entire conversation, so last_input + last_output
-- is the conversation's size in tokens — the number the meter shows.
-- Nullable: rows written before 0051 have no per-slice data (forward-only
-- metering, the 0047 decision).

ALTER TABLE usage_events ADD last_input_tokens integer;
--> statement-breakpoint
ALTER TABLE usage_events ADD last_cached_tokens integer;
--> statement-breakpoint
ALTER TABLE usage_events ADD last_output_tokens integer;
--> statement-breakpoint
ALTER TABLE usage_events ADD last_reasoning_tokens integer;
