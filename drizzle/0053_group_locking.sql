-- 0046 locked thread groups: re-file every child to its root ancestor's
-- folder, fixing groups that diverged before moves cascaded (data-only;
-- no schema change). Children come in two kinds: start_thread chats
-- (conversations.parent_conversation_id, statement 1) and historical
-- machine runs (machine_runs.parent_conversation_id — a kind:"run"
-- conversation's id IS its machine_runs id — statement 2).
--
-- Statement 1: UNION (not UNION ALL) keeps the recursive walk finite
-- even if corrupt data ever closed a parent cycle; a node whose chain
-- never reaches a root (cycle) keeps its own folder. The statement never
-- writes parent_conversation_id or any root row, so the mapping is
-- stable while the UPDATE runs. Statement 2 runs after it, so a run
-- files into its parent chat's ALREADY-rooted folder.
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
--> statement-breakpoint
-- Statement 2: one join, one level (a run is never itself a parent, so
-- no recursion); the EXISTS guard leaves runs without a parent link
-- untouched.
UPDATE conversations
   SET folder_id = (
         SELECT chats.folder_id
           FROM machine_runs
           JOIN conversations AS chats ON chats.id = machine_runs.parent_conversation_id
          WHERE machine_runs.id = conversations.id
       )
 WHERE kind = 'run'
   AND EXISTS (
         SELECT 1 FROM machine_runs
          WHERE machine_runs.id = conversations.id
            AND machine_runs.parent_conversation_id IS NOT NULL
       );
