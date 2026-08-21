CREATE TABLE IF NOT EXISTS task_reward_memory_jobs (
  id text PRIMARY KEY,
  task_id text NOT NULL,
  account_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  source_packet_digest text NOT NULL DEFAULT '',
  source_packet_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_packet_text text NOT NULL DEFAULT '',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text NOT NULL DEFAULT '',
  memory_entry_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS task_reward_memory_jobs_task_idx
  ON task_reward_memory_jobs (task_id);

CREATE INDEX IF NOT EXISTS task_reward_memory_jobs_claim_idx
  ON task_reward_memory_jobs (status, next_attempt_at, created_at, id);

CREATE INDEX IF NOT EXISTS task_reward_memory_jobs_account_recent_idx
  ON task_reward_memory_jobs (account_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS chat_memory_entries_rewarded_task_recent_idx
  ON chat_memory_entries (account_id, created_at DESC, id)
  WHERE kind = 'rewarded_task_memory';
