CREATE TABLE `conversation_events` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`type` text NOT NULL,
	`event` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `conversation_events_conversation_idx` ON `conversation_events` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`event_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversations_updated_at_idx` ON `conversations` (`updated_at`);