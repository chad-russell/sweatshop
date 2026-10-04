CREATE TABLE `sandbox_services` (
	`id` text PRIMARY KEY NOT NULL,
	`sandbox_id` text NOT NULL,
	`name` text NOT NULL,
	`image` text NOT NULL,
	`ref` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'creating' NOT NULL,
	`port` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`sandbox_id`) REFERENCES `sandboxes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sandbox_services_sandbox_name_idx` ON `sandbox_services` (`sandbox_id`,`name`);--> statement-breakpoint
ALTER TABLE `sandboxes` ADD `services_provisioned_at` integer;