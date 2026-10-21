-- 0055 ticket mode: the sticky mode's current phase. Null = no mode
-- entered (ordinary chat), or a legacy thread bound to skill = "ticket"
-- before this column existed — both read the same as "no phase set".
ALTER TABLE `conversations` ADD `mode_phase` text;