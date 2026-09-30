DROP INDEX `harness_events_session_idx`;--> statement-breakpoint
ALTER TABLE `harness_events` ADD `harness` text DEFAULT 'pi' NOT NULL;--> statement-breakpoint
CREATE INDEX `harness_events_session_idx` ON `harness_events` (`session_id`,`harness`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_harness_runs` (
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`tool_calls` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	`error` text
);
--> statement-breakpoint
INSERT INTO `__new_harness_runs`("session_id", "kind", "status", "tool_calls", "started_at", "last_at", "error") SELECT "session_id", "kind", "status", "tool_calls", "started_at", "last_at", NULL FROM `harness_runs`;--> statement-breakpoint
DROP TABLE `harness_runs`;--> statement-breakpoint
ALTER TABLE `__new_harness_runs` RENAME TO `harness_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `harness_runs_session_kind_idx` ON `harness_runs` (`session_id`,`kind`);