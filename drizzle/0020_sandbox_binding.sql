ALTER TABLE `conversations` ADD `sandbox_id` text REFERENCES sandboxes(id);--> statement-breakpoint
ALTER TABLE `conversations` ADD `sandbox_work_dir` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `sandbox_owner` integer;--> statement-breakpoint
ALTER TABLE `conversations` ADD `sandbox_disabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- 0013: fold the per-call sandbox_pref into the fixed binding.
-- "none" → disabled. "attached:<id>" → bound to that sandbox, not owner,
-- in the directory the chat actually used (/work/<conversationId>).
-- null + a live own sandbox → bound, owner. Anything else stays pending
-- (project chats) or none (plain chats), derived from project_id.
UPDATE `conversations` SET `sandbox_disabled` = 1 WHERE `sandbox_pref` = 'none';--> statement-breakpoint
UPDATE `conversations`
SET `sandbox_id` = substr(`sandbox_pref`, 10),
    `sandbox_work_dir` = '/work/' || `id`,
    `sandbox_owner` = 0
WHERE `sandbox_pref` LIKE 'attached:%'
  AND substr(`sandbox_pref`, 10) IN (SELECT `id` FROM `sandboxes`);--> statement-breakpoint
UPDATE `conversations`
SET `sandbox_id` = (
      SELECT s.`id` FROM `sandboxes` s
      WHERE s.`owner_kind` = 'conversation' AND s.`owner_id` = `conversations`.`id`
        AND s.`status` != 'destroyed'),
    `sandbox_work_dir` = '/work/' || `id`,
    `sandbox_owner` = 1
WHERE `sandbox_pref` IS NULL
  AND EXISTS (
      SELECT 1 FROM `sandboxes` s
      WHERE s.`owner_kind` = 'conversation' AND s.`owner_id` = `conversations`.`id`
        AND s.`status` != 'destroyed');
