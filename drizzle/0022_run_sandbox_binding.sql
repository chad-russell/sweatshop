ALTER TABLE `machine_runs` ADD `sandbox_id` text REFERENCES sandboxes(id);--> statement-breakpoint
ALTER TABLE `machine_runs` ADD `sandbox_work_dir` text;--> statement-breakpoint
ALTER TABLE `machine_runs` ADD `sandbox_owner` integer;--> statement-breakpoint
-- 0013: every pre-0013 project run owned its sandbox at /work/<runId>;
-- bind each run to its most recent lease (live or destroyed — destroyed
-- rows stay as history, 0011).
UPDATE `machine_runs`
SET `sandbox_id` = (
      SELECT s.`id` FROM `sandboxes` s
      WHERE s.`owner_kind` = 'machine_run' AND s.`owner_id` = `machine_runs`.`id`
      ORDER BY s.`created_at` DESC LIMIT 1),
    `sandbox_work_dir` = '/work/' || `id`,
    `sandbox_owner` = 1
WHERE EXISTS (
      SELECT 1 FROM `sandboxes` s
      WHERE s.`owner_kind` = 'machine_run' AND s.`owner_id` = `machine_runs`.`id`);
