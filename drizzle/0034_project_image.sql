ALTER TABLE `projects` ADD `image_ref` text;--> statement-breakpoint
UPDATE `projects` SET `image_ref` = (SELECT `image_ref` FROM `sandbox_configs` WHERE `sandbox_configs`.`id` = COALESCE(`projects`.`sandbox_config_id`, 'default'));--> statement-breakpoint
CREATE TABLE `__new_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`image_ref` text,
	`created_at` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_projects` (`id`,`name`,`description`,`image_ref`,`created_at`) SELECT `id`,`name`,`description`,`image_ref`,`created_at` FROM `projects`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;--> statement-breakpoint
DROP TABLE `sandbox_configs`;
