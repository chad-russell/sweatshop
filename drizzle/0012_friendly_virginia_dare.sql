CREATE TABLE `steer_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `steer_queue_conversation_idx` ON `steer_queue` (`conversation_id`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `active_run_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `model_message` text;