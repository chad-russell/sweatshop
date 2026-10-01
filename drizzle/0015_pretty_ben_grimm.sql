CREATE TABLE `pending_inputs` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`kind` text NOT NULL,
	`question` text NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	`answer` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pending_inputs_conversation_idx` ON `pending_inputs` (`conversation_id`);