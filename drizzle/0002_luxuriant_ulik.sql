CREATE TABLE `git_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`username` text NOT NULL,
	`secret` text NOT NULL,
	`base_url` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_repos` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`url` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `project_repos_project_idx` ON `project_repos` (`project_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`sandbox_config_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`sandbox_config_id`) REFERENCES `sandbox_configs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sandbox_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`provider` text DEFAULT 'docker' NOT NULL,
	`image_ref` text,
	`network_policy` text DEFAULT 'allow-all' NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL
);
