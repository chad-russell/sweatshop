-- 0055 v7 part B: phase handoff. The child's own spawned-for phase
-- (display name, distinct from a conversation's own mode_phase) and the
-- phase a harness call ran under.
ALTER TABLE `conversations` ADD `work_phase` text;
--> statement-breakpoint
ALTER TABLE `harness_calls` ADD `phase` text;
