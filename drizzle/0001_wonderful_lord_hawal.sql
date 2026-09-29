CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `messages_conversation_idx` ON `messages` (`conversation_id`);
--> statement-breakpoint
-- 0003: FTS5 index over extracted message text. External-content over
-- messages.rowid; triggers keep the index correct for every writer
-- (mirror, backfill). Rebuildable: delete from messages_fts + reinsert,
-- or drop and recreate.
CREATE VIRTUAL TABLE `messages_fts` USING fts5(`text`, content=`messages`, content_rowid=`rowid`, tokenize='porter unicode61');
--> statement-breakpoint
CREATE TRIGGER `messages_ai` AFTER INSERT ON `messages` BEGIN
	INSERT INTO `messages_fts`(`rowid`, `text`) VALUES (new.`rowid`, new.`text`);
END;
--> statement-breakpoint
CREATE TRIGGER `messages_ad` AFTER DELETE ON `messages` BEGIN
	INSERT INTO `messages_fts`(`messages_fts`, `rowid`, `text`) VALUES ('delete', old.`rowid`, old.`text`);
END;
--> statement-breakpoint
CREATE TRIGGER `messages_au` AFTER UPDATE ON `messages` BEGIN
	INSERT INTO `messages_fts`(`messages_fts`, `rowid`, `text`) VALUES ('delete', old.`rowid`, old.`text`);
	INSERT INTO `messages_fts`(`rowid`, `text`) VALUES (new.`rowid`, new.`text`);
END;