CREATE TABLE `project_hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`address` text NOT NULL,
	`user` text NOT NULL,
	`api_base` text,
	`host_key_fp` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `project_hosts_project_idx` ON `project_hosts` (`project_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_hosts_project_name_uq` ON `project_hosts` (`project_id`,`name`);
--> statement-breakpoint
CREATE TABLE `host_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`host_id` text NOT NULL,
	`host_name` text NOT NULL,
	`command` text NOT NULL,
	`exit_code` integer,
	`output` text,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `host_commands_conversation_idx` ON `host_commands` (`conversation_id`);
