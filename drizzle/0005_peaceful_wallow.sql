CREATE TABLE `harness_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`tool_name` text,
	`input` text,
	`output` text,
	`text` text
);
--> statement-breakpoint
CREATE INDEX `harness_events_session_idx` ON `harness_events` (`session_id`);