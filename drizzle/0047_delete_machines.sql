DROP TABLE `machines`;--> statement-breakpoint
DROP TABLE `pr_proposals`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_machine_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`machine_id` text,
	`machine_name` text NOT NULL,
	`machine_version` integer NOT NULL,
	`definition` text NOT NULL,
	`project_id` text,
	`prompt` text NOT NULL,
	`status` text NOT NULL,
	`current_stage` text,
	`sandbox_id` text,
	`sandbox_work_dir` text,
	`sandbox_owner` integer,
	`error` text,
	`settled_at` integer,
	`parent_conversation_id` text,
	`woken_settled_at` integer,
	`workflow_run_id` text,
	`overrides` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sandbox_id`) REFERENCES `sandboxes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_machine_runs`("id", "machine_id", "machine_name", "machine_version", "definition", "project_id", "prompt", "status", "current_stage", "sandbox_id", "sandbox_work_dir", "sandbox_owner", "error", "settled_at", "parent_conversation_id", "woken_settled_at", "workflow_run_id", "overrides", "created_at", "updated_at") SELECT "id", "machine_id", "machine_name", "machine_version", "definition", "project_id", "prompt", "status", "current_stage", "sandbox_id", "sandbox_work_dir", "sandbox_owner", "error", "settled_at", "parent_conversation_id", "woken_settled_at", "workflow_run_id", "overrides", "created_at", "updated_at" FROM `machine_runs`;--> statement-breakpoint
DROP TABLE `machine_runs`;--> statement-breakpoint
ALTER TABLE `__new_machine_runs` RENAME TO `machine_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `machine_runs_created_idx` ON `machine_runs` (`created_at`);