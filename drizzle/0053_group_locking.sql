-- 0046 locked thread groups: re-file every conversation that has a
-- parent to its root ancestor's folder, fixing groups that diverged
-- before moves cascaded (data-only; no schema change).
--
-- UNION (not UNION ALL) keeps the recursive walk finite even if corrupt
-- data ever closed a parent cycle; a node whose chain never reaches a
-- root (cycle) keeps its own folder. The statement never writes
-- parent_conversation_id or any root row, so the mapping is stable
-- while the UPDATE runs.
WITH RECURSIVE rooted(id, folder_id) AS (
    SELECT id, folder_id FROM conversations WHERE parent_conversation_id IS NULL
  UNION
    SELECT conversations.id, rooted.folder_id
      FROM conversations
      JOIN rooted ON conversations.parent_conversation_id = rooted.id
)
UPDATE conversations
   SET folder_id = (SELECT folder_id FROM rooted WHERE rooted.id = conversations.id)
 WHERE parent_conversation_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM rooted WHERE rooted.id = conversations.id);
