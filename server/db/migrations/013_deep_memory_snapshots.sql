ALTER TABLE chat_deep_memory_jobs
  ADD COLUMN IF NOT EXISTS source_entry_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

WITH ranked_turn_memory AS (
  SELECT
    id,
    account_id,
    row_number() OVER (PARTITION BY account_id ORDER BY created_at ASC, id ASC) AS ordinal
  FROM chat_memory_entries
  WHERE kind = 'turn_memory'
),
snapshots AS (
  SELECT
    job.id AS job_id,
    jsonb_agg(ranked_turn_memory.id ORDER BY ranked_turn_memory.ordinal) AS source_entry_ids,
    count(*)::integer AS source_count
  FROM chat_deep_memory_jobs AS job
  JOIN ranked_turn_memory
    ON ranked_turn_memory.account_id = job.account_id
   AND ranked_turn_memory.ordinal > ((job.block_index - 1) * 36)
   AND ranked_turn_memory.ordinal <= (job.block_index * 36)
  WHERE jsonb_array_length(job.source_entry_ids) = 0
  GROUP BY job.id
)
UPDATE chat_deep_memory_jobs AS job
SET source_entry_ids = snapshots.source_entry_ids,
    updated_at = now()
FROM snapshots
WHERE job.id = snapshots.job_id
  AND snapshots.source_count = 36;

WITH duplicate_deep_memory AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY account_id, deep_memory_block_index
      ORDER BY created_at DESC, id DESC
    ) AS duplicate_rank
  FROM chat_memory_entries
  WHERE kind = 'deep_memory'
    AND deep_memory_block_index IS NOT NULL
)
DELETE FROM chat_memory_entries AS entry
USING duplicate_deep_memory
WHERE entry.id = duplicate_deep_memory.id
  AND duplicate_deep_memory.duplicate_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS chat_memory_entries_deep_block_unique_idx
  ON chat_memory_entries (account_id, deep_memory_block_index)
  WHERE kind = 'deep_memory'
    AND deep_memory_block_index IS NOT NULL;
