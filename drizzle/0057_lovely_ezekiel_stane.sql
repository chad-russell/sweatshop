CREATE TABLE `prompt_section_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`version` integer NOT NULL,
	`body` text NOT NULL,
	`edited_by` text NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`key`) REFERENCES `prompt_sections`(`key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_section_versions_key_version_idx` ON `prompt_section_versions` (`key`,`version`);--> statement-breakpoint
CREATE TABLE `prompt_sections` (
	`key` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`version` integer NOT NULL,
	`edited_by` text NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `skill_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`skill_id` text NOT NULL,
	`version` integer NOT NULL,
	`description` text NOT NULL,
	`thread` integer NOT NULL,
	`status` text NOT NULL,
	`body` text NOT NULL,
	`edited_by` text NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_versions_skill_id_version_idx` ON `skill_versions` (`skill_id`,`version`);--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`origin` text NOT NULL,
	`description` text NOT NULL,
	`thread` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`body` text NOT NULL,
	`version` integer NOT NULL,
	`edited_by` text NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
