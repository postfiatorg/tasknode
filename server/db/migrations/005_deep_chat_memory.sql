ALTER TABLE chat_memory_entries
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'turn_memory';

ALTER TABLE chat_memory_entries
  ADD COLUMN IF NOT EXISTS deep_memory_block_index integer;

CREATE INDEX IF NOT EXISTS chat_memory_entries_account_kind_recent_idx
  ON chat_memory_entries (account_id, kind, created_at DESC, id);

CREATE TABLE IF NOT EXISTS chat_deep_memory_jobs (
  id text PRIMARY KEY,
  account_id text NOT NULL DEFAULT '',
  block_index integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS chat_deep_memory_jobs_account_block_idx
  ON chat_deep_memory_jobs (account_id, block_index);

CREATE INDEX IF NOT EXISTS chat_deep_memory_jobs_claim_idx
  ON chat_deep_memory_jobs (status, next_attempt_at, created_at, id);
