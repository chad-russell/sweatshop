ALTER TABLE `conversations` ADD `last_seen_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `conversation_events_type_idx` ON `conversation_events` (`type`);--> statement-breakpoint
-- 0008 (inbox): everything that exists today counts as already seen.
UPDATE `conversations` SET `last_seen_at` = `updated_at`;
