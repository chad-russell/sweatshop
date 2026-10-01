CREATE TABLE `folders` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`parent_id` text,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `folders_project_idx` ON `folders` (`project_id`);--> statement-breakpoint
CREATE INDEX `folders_parent_idx` ON `folders` (`parent_id`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `summary` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `title_source` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `title_generations` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `folder_id` text REFERENCES folders(id);--> statement-breakpoint
ALTER TABLE `conversations` ADD `archived_at` integer;--> statement-breakpoint
ALTER TABLE `conversations` ADD `trashed_at` integer;--> statement-breakpoint
CREATE INDEX `conversations_folder_idx` ON `conversations` (`folder_id`);--> statement-breakpoint
-- 0007: FTS5 over conversation title + summary (external-content over
-- conversations.rowid, like messages_fts). Triggers fire only when those
-- columns change, not on every updated_at bump. Rebuildable via
-- INSERT INTO conversations_fts(conversations_fts) VALUES ('rebuild').
CREATE VIRTUAL TABLE `conversations_fts` USING fts5(`title`, `summary`, content=`conversations`, content_rowid=`rowid`, tokenize='porter unicode61');
--> statement-breakpoint
CREATE TRIGGER `conversations_fts_ai` AFTER INSERT ON `conversations` BEGIN
	INSERT INTO `conversations_fts`(`rowid`, `title`, `summary`) VALUES (new.`rowid`, coalesce(new.`title`, ''), coalesce(new.`summary`, ''));
END;
--> statement-breakpoint
CREATE TRIGGER `conversations_fts_ad` AFTER DELETE ON `conversations` BEGIN
	INSERT INTO `conversations_fts`(`conversations_fts`, `rowid`, `title`, `summary`) VALUES ('delete', old.`rowid`, coalesce(old.`title`, ''), coalesce(old.`summary`, ''));
END;
--> statement-breakpoint
CREATE TRIGGER `conversations_fts_au` AFTER UPDATE OF `title`, `summary` ON `conversations` BEGIN
	INSERT INTO `conversations_fts`(`conversations_fts`, `rowid`, `title`, `summary`) VALUES ('delete', old.`rowid`, coalesce(old.`title`, ''), coalesce(old.`summary`, ''));
	INSERT INTO `conversations_fts`(`rowid`, `title`, `summary`) VALUES (new.`rowid`, coalesce(new.`title`, ''), coalesce(new.`summary`, ''));
END;
--> statement-breakpoint
INSERT INTO `conversations_fts`(`rowid`, `title`, `summary`) SELECT `rowid`, coalesce(`title`, ''), coalesce(`summary`, '') FROM `conversations`;
