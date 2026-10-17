ALTER TABLE `conversations` ADD `host_auto_approve` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `host_commands` ADD `auto_approved` integer DEFAULT false NOT NULL;
