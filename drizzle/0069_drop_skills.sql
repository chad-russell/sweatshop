-- 0088: skills move to an S3-backed catalog. The DB catalog tables and
-- the thread-binding column go away (existing threads become plain).
DROP TABLE `skill_versions`;
--> statement-breakpoint
DROP TABLE `skills`;
--> statement-breakpoint
ALTER TABLE `conversations` DROP COLUMN `skill`;
