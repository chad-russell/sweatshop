ALTER TABLE `conversations` ADD `project_id` text REFERENCES projects(id);--> statement-breakpoint
CREATE INDEX `conversations_project_idx` ON `conversations` (`project_id`);