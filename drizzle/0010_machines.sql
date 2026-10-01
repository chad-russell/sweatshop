CREATE TABLE `machine_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`machine_id` text,
	`machine_name` text NOT NULL,
	`machine_version` integer NOT NULL,
	`definition` text NOT NULL,
	`project_id` text,
	`prompt` text NOT NULL,
	`status` text NOT NULL,
	`current_stage` text,
	`container_name` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `machine_runs_created_idx` ON `machine_runs` (`created_at`);--> statement-breakpoint
CREATE TABLE `machine_stage_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`stage_id` text NOT NULL,
	`kind` text NOT NULL,
	`harness` text,
	`status` text NOT NULL,
	`session_id` text,
	`outcome` text,
	`transition_to` text,
	`steps` integer DEFAULT 0 NOT NULL,
	`error` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `machine_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machine_stage_runs_run_seq_idx` ON `machine_stage_runs` (`run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `machines` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`definition` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
