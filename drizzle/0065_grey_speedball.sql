ALTER TABLE `conversations` DROP COLUMN `mode_phase`;--> statement-breakpoint
ALTER TABLE `conversations` DROP COLUMN `work_phase`;--> statement-breakpoint
ALTER TABLE `harness_calls` DROP COLUMN `phase`;--> statement-breakpoint
ALTER TABLE `harness_calls` DROP COLUMN `phase_skill_id`;--> statement-breakpoint
ALTER TABLE `harness_calls` DROP COLUMN `phase_skill_version`;--> statement-breakpoint
ALTER TABLE `harness_calls` DROP COLUMN `phase_id`;--> statement-breakpoint
ALTER TABLE `skill_versions` DROP COLUMN `mode`;--> statement-breakpoint
ALTER TABLE `skills` DROP COLUMN `mode`;