CREATE TABLE `pr_watches` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`base_url` text NOT NULL,
	`owner` text NOT NULL,
	`repo` text NOT NULL,
	`number` integer NOT NULL,
	`state` text NOT NULL,
	`opened_at` integer NOT NULL,
	`settled_at` integer,
	`head_sha` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pr_watches_state_idx` ON `pr_watches` (`state`);