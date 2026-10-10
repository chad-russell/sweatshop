ALTER TABLE `conversations` ADD `parent_conversation_id` text REFERENCES conversations(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `woken_settled_at` integer;
