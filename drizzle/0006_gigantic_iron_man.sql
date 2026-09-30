CREATE TABLE `harness_runs` (
	`session_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`tool_calls` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`last_at` integer NOT NULL
);
