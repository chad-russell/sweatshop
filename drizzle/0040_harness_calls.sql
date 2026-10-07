CREATE TABLE `harness_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`kind` text NOT NULL,
	`task` text NOT NULL,
	`status` text NOT NULL,
	`result` text,
	`error` text,
	`workflow_run_id` text,
	`settled_at` integer,
	`woken_settled_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `harness_calls_conversation_idx` ON `harness_calls` (`conversation_id`);