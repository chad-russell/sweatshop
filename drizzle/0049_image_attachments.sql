CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`media_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`conversation_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `attachments_conversation_idx` ON `attachments` (`conversation_id`);
