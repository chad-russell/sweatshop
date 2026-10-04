CREATE TABLE `preview_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`preview_id` text NOT NULL,
	`sha` text NOT NULL,
	`result` text NOT NULL,
	`detail` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`preview_id`) REFERENCES `previews`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `preview_events_preview_idx` ON `preview_events` (`preview_id`,`at`);--> statement-breakpoint
ALTER TABLE `previews` ADD `failed_sha` text;--> statement-breakpoint
ALTER TABLE `previews` ADD `dismissed_sha` text;