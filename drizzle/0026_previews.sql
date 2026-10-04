CREATE TABLE `previews` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`sandbox_id` text NOT NULL,
	`work_dir` text NOT NULL,
	`command` text NOT NULL,
	`port` integer NOT NULL,
	`label` text,
	`source` text NOT NULL,
	`repo_id` text,
	`branch` text,
	`head_sha` text,
	`status` text NOT NULL,
	`started_by` text NOT NULL,
	`last_request_at` integer,
	`error` text,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`sandbox_id`) REFERENCES `sandboxes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repo_id`) REFERENCES `project_repos`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `previews_slug_idx` ON `previews` (`slug`) WHERE "previews"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `previews_sandbox_idx` ON `previews` (`sandbox_id`);--> statement-breakpoint
ALTER TABLE `sandbox_configs` ADD `preview_command` text;--> statement-breakpoint
ALTER TABLE `sandbox_configs` ADD `preview_port` integer;