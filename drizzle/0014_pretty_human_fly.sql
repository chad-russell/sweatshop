CREATE TABLE `chat_harness_state` (
	`conversation_id` text NOT NULL,
	`harness` text NOT NULL,
	`resume_from` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`conversation_id`, `harness`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chat_harness_state_idx` ON `chat_harness_state` (`conversation_id`);