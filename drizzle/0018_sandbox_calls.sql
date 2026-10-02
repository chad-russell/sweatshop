CREATE TABLE `sandbox_calls` (
	`tool_call_id` text PRIMARY KEY NOT NULL,
	`sandbox_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`tool` text NOT NULL,
	`via` text NOT NULL,
	`workdir` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`sandbox_id`) REFERENCES `sandboxes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sandbox_calls_sandbox_idx` ON `sandbox_calls` (`sandbox_id`);--> statement-breakpoint
CREATE INDEX `sandbox_calls_conversation_idx` ON `sandbox_calls` (`conversation_id`);--> statement-breakpoint
DROP INDEX `sandboxes_owner_idx`;--> statement-breakpoint
ALTER TABLE `sandboxes` ADD `destroyed_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `sandboxes_owner_idx` ON `sandboxes` (`owner_kind`,`owner_id`) WHERE "sandboxes"."status" != 'destroyed';