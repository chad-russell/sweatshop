ALTER TABLE `machine_runs` ADD `parent_conversation_id` text REFERENCES conversations(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `machine_runs` ADD `woken_settled_at` integer;
