-- 0010 Phase 5: machine stage kind eve -> agent (in-process WorkflowAgent
-- turns replace eve conversations). Stored definitions are JSON with
-- compact keys, so a string replace is exact; db/machines re-validates
-- every definition on read.
UPDATE `machines` SET `definition` = replace(`definition`, '"kind":"eve"', '"kind":"agent"') WHERE `definition` LIKE '%"kind":"eve"%';
