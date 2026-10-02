ALTER TABLE `conversations` ADD `kind` text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE `machine_runs` ADD `settled_at` integer;--> statement-breakpoint
ALTER TABLE `machine_runs` ADD `workflow_run_id` text;--> statement-breakpoint
-- 0012 backfill: every existing run becomes a `run` conversation (id =
-- run id; title = the prompt's first line, clipped; already seen so
-- history does not light up as unread).
INSERT OR IGNORE INTO `conversations` (`id`, `title`, `project_id`, `kind`, `created_at`, `updated_at`, `last_seen_at`)
SELECT `id`,
       substr(trim(substr(`prompt`, 1, instr(`prompt` || char(10), char(10)) - 1)), 1, 60),
       `project_id`, 'run', `created_at`, `updated_at`, `updated_at`
FROM `machine_runs`;--> statement-breakpoint
UPDATE `conversations` SET `kind` = 'stage' WHERE `id` GLOB 'mr_*_[0-9]*' AND `kind` = 'chat';--> statement-breakpoint
UPDATE `machine_runs` SET `settled_at` = `updated_at` WHERE `status` IN ('waiting', 'needs-attention', 'completed', 'failed');
