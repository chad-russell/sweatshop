-- 0055 v7 modes: a skill can be flagged as a mode (freeform phases in
-- its own markdown). Implies thread; parsed by lib/agent/mode-ids.ts.
ALTER TABLE `skill_versions` ADD `mode` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `skills` ADD `mode` integer DEFAULT false NOT NULL;
