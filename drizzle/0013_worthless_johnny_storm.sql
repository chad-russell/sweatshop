CREATE TABLE `sandbox_attachments` (
	`sandbox_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`workdir` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`sandbox_id`) REFERENCES `sandboxes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sandbox_attachments_idx` ON `sandbox_attachments` (`sandbox_id`,`conversation_id`);--> statement-breakpoint
CREATE INDEX `sandbox_attachments_conversation_idx` ON `sandbox_attachments` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `sandboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`ref` text NOT NULL,
	`owner_kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`project_id` text,
	`status` text NOT NULL,
	`last_used_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sandboxes_owner_idx` ON `sandboxes` (`owner_kind`,`owner_id`);--> statement-breakpoint
CREATE INDEX `sandboxes_status_idx` ON `sandboxes` (`status`);