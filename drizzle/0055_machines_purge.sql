-- 0048 machines purge (option C): the 12 machine_runs rows are 2026-10-10
-- e2e artifacts ("tabs or spaces?" — the live-DB evidence in the doc);
-- both writers and readers are already deleted. This migration deletes
-- the run conversations with every dependent row (same teardown order
-- as db/organize.ts's deleteConversationForever), then drops the two
-- machine tables. FKs are OFF for the run (the migrate runner's
-- posture); the runner's foreign_key_check gate after re-enforcing
-- must (and does) come back clean: every dependent table is covered.
--
-- Stage conversations have ids '<runId>_<seq>' and kind 'stage'; run
-- conversations are kind 'run' (their id IS the machine_runs id).

-- 1. Dependent rows of every run/stage conversation (stage ids glob to
--    'mr_*_*'; kind='run' ids are 'mr_*' with no second underscore — the
--    LIKE patterns below capture exactly the two sets).
DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE kind = 'run' OR kind = 'stage');
--> statement-breakpoint
DELETE FROM harness_events WHERE session_id IN (SELECT id FROM conversations WHERE kind = 'run' OR kind = 'stage');
--> statement-breakpoint
DELETE FROM harness_runs WHERE session_id IN (SELECT id FROM conversations WHERE kind = 'run' OR kind = 'stage');
--> statement-breakpoint
DELETE FROM steer_queue WHERE conversation_id IN (SELECT id FROM conversations WHERE kind = 'run' OR kind = 'stage');
--> statement-breakpoint
DELETE FROM chat_harness_state WHERE conversation_id IN (SELECT id FROM conversations WHERE kind = 'run' OR kind = 'stage');
--> statement-breakpoint
DELETE FROM pending_inputs WHERE conversation_id IN (SELECT id FROM conversations WHERE kind = 'run' OR kind = 'stage');
--> statement-breakpoint
DELETE FROM host_commands WHERE conversation_id IN (SELECT id FROM conversations WHERE kind = 'run' OR kind = 'stage');
--> statement-breakpoint
DELETE FROM sandbox_attachments WHERE conversation_id IN (SELECT id FROM conversations WHERE kind = 'run' OR kind = 'stage');
--> statement-breakpoint
DELETE FROM usage_events WHERE conversation_id IN (SELECT id FROM conversations WHERE kind = 'run' OR kind = 'stage');
--> statement-breakpoint
DELETE FROM attachments WHERE conversation_id IN (SELECT id FROM conversations WHERE kind = 'run' OR kind = 'stage');
--> statement-breakpoint
-- harness_calls FK conversations with cascade and NOT NULL — a call a
-- run conversation started (none known, but the check is cheap).
DELETE FROM harness_calls WHERE conversation_id IN (SELECT id FROM conversations WHERE kind = 'run' OR kind = 'stage');
--> statement-breakpoint

-- 2. The conversations themselves, then the machine tables.
DELETE FROM conversations WHERE kind = 'run' OR kind = 'stage';
--> statement-breakpoint
DELETE FROM machine_stage_runs;
--> statement-breakpoint
DELETE FROM machine_runs;
--> statement-breakpoint
DROP TABLE machine_stage_runs;
--> statement-breakpoint
DROP TABLE machine_runs;
