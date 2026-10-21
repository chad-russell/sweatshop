-- 0059: the skill version and phase id a harness call's handoff was
-- rendered from, so its card can re-render that exact block later.
ALTER TABLE `harness_calls` ADD `phase_skill_id` text;
--> statement-breakpoint
ALTER TABLE `harness_calls` ADD `phase_skill_version` integer;
--> statement-breakpoint
ALTER TABLE `harness_calls` ADD `phase_id` text;
