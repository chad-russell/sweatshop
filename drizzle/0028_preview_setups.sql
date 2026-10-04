CREATE TABLE `preview_setups` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`definition` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `preview_setups_project_idx` ON `preview_setups` (`project_id`);--> statement-breakpoint
ALTER TABLE `sandbox_configs` DROP COLUMN `preview_command`;--> statement-breakpoint
ALTER TABLE `sandbox_configs` DROP COLUMN `preview_port`;