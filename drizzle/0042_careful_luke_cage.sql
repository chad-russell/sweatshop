CREATE TABLE `pr_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`project_id` text NOT NULL,
	`repo` text NOT NULL,
	`head` text NOT NULL,
	`base` text,
	`title` text NOT NULL,
	`body` text,
	`summary` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`result_url` text,
	`result_number` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `machine_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pr_proposals_run_idx` ON `pr_proposals` (`run_id`);