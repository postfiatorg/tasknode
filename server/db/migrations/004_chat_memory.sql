CREATE TABLE IF NOT EXISTS chat_memory_jobs (
  id text PRIMARY KEY,
  account_id text NOT NULL DEFAULT '',
  conversation_id text NOT NULL,
  user_message_id text NOT NULL,
  assistant_message_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS chat_memory_jobs_assistant_message_idx
  ON chat_memory_jobs (assistant_message_id);

CREATE INDEX IF NOT EXISTS chat_memory_jobs_claim_idx
  ON chat_memory_jobs (status, next_attempt_at, created_at, id);

CREATE INDEX IF NOT EXISTS chat_memory_jobs_account_recent_idx
  ON chat_memory_jobs (account_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS chat_memory_entries (
  id text PRIMARY KEY,
  account_id text NOT NULL DEFAULT '',
  conversation_id text NOT NULL,
  conversation_title text NOT NULL DEFAULT '',
  user_message_id text NOT NULL,
  assistant_message_id text NOT NULL,
  user_request_summary text NOT NULL DEFAULT '',
  system_response_summary text NOT NULL DEFAULT '',
  memory_text text NOT NULL DEFAULT '',
  source_user_excerpt text NOT NULL DEFAULT '',
  source_assistant_excerpt text NOT NULL DEFAULT '',
  provider text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  prompt_version text NOT NULL DEFAULT '',
  usage_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS chat_memory_entries_assistant_message_idx
  ON chat_memory_entries (assistant_message_id);

CREATE INDEX IF NOT EXISTS chat_memory_entries_account_recent_idx
  ON chat_memory_entries (account_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS chat_memory_entries_conversation_recent_idx
  ON chat_memory_entries (conversation_id, created_at DESC, id);
