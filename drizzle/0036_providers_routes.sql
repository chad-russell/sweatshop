CREATE TABLE `provider_models` (
	`provider` text NOT NULL,
	`id` text NOT NULL,
	`label` text NOT NULL,
	`context_window` integer NOT NULL,
	`max_tokens` integer NOT NULL,
	`vision` integer DEFAULT false NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`provider`, `id`)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `machine_runs` ADD `overrides` text;--> statement-breakpoint
ALTER TABLE `machine_stage_runs` ADD `route` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `default_route` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `allowed_providers` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `allowed_harnesses` text;--> statement-breakpoint
UPDATE `machines` SET `definition` = (
  SELECT json_set(`machines`.`definition`, '$.stages', json_group_object(s.key, json_remove(s.value, '$.model', '$.thinking')))
  FROM json_each(`machines`.`definition`, '$.stages') AS s
) WHERE EXISTS (
  SELECT 1 FROM json_each(`machines`.`definition`, '$.stages') AS s
  WHERE json_type(s.value, '$.model') IS NOT NULL OR json_type(s.value, '$.thinking') IS NOT NULL
);
