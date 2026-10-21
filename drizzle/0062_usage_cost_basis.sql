-- Forward-only: old rows read as computed (null basis).
ALTER TABLE `usage_events` ADD `cost_basis` text;
