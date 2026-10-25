-- 0083 harness lanes.
--
-- harness_runs.dir is NOT NULL DEFAULT '' (the default lane), not nullable
-- as the design doc's prose suggests — sqlite/ANSI unique indexes treat
-- NULL as distinct from NULL, so a NULL sentinel would make every
-- onConflictDoUpdate("session_id","kind","dir") miss on the default lane's
-- repeat claims/settles, inserting a new row each time instead of reusing
-- the slot (the running row would never flip to settled, and the next
-- same-kind claim would see it and report busy forever). '' sidesteps
-- that pitfall while reading identically to "no dir" everywhere else.
--
-- harness_runs.port is the lane bridge port lease: a single nullable
-- integer column (not a separate lease table) — claimHarnessRun grants it
-- from the shared LANE_BRIDGE_PORTS pool inside the same transaction that
-- claims the slot, and settling always nulls it back, releasing it. One
-- row already IS one lease for the run's lifetime, so a second table
-- would only duplicate that lifecycle.
--
-- harness_events.dir is nullable (no uniqueness concern) and purely
-- informational — the (session_id, harness) index is unchanged; it only
-- feeds the lane chip in the /h events view.
--
-- harness_calls.dir is nullable, recorded for inspect/display; no index.
DROP INDEX `harness_runs_session_kind_idx`;--> statement-breakpoint
ALTER TABLE `harness_runs` ADD `dir` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `harness_runs` ADD `port` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `harness_runs_session_kind_dir_idx` ON `harness_runs` (`session_id`,`kind`,`dir`);--> statement-breakpoint
ALTER TABLE `harness_calls` ADD `dir` text;--> statement-breakpoint
ALTER TABLE `harness_events` ADD `dir` text;