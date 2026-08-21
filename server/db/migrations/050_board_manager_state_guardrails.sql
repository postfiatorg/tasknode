CREATE TABLE IF NOT EXISTS board_manager_followups (
  id text PRIMARY KEY,
  run_id text NOT NULL DEFAULT '',
  account_id text NOT NULL DEFAULT '',
  project_id text NOT NULL DEFAULT '',
  hive_context_entry_id text NOT NULL DEFAULT '',
  response_hive_context_entry_id text NOT NULL DEFAULT '',
  conversation_id text NOT NULL DEFAULT '',
  board_message_id text NOT NULL DEFAULT '',
  chat_message_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open',
  blocker_type text NOT NULL DEFAULT '',
  blocker_summary text NOT NULL DEFAULT '',
  expected_response text NOT NULL DEFAULT '',
  source_packet_digest text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_sent_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  resolved_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT board_manager_followups_status_chk
    CHECK (status IN ('open', 'answered', 'resolved', 'expired', 'archived'))
);

CREATE INDEX IF NOT EXISTS board_manager_followups_open_account_idx
  ON board_manager_followups (account_id, project_id, last_sent_at DESC, id)
  WHERE status = 'open';

CREATE UNIQUE INDEX IF NOT EXISTS board_manager_followups_open_account_project_unique
  ON board_manager_followups (account_id, project_id)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS board_manager_followups_hive_context_idx
  ON board_manager_followups (hive_context_entry_id, account_id, status)
  WHERE hive_context_entry_id <> '';

CREATE INDEX IF NOT EXISTS board_manager_followups_response_context_idx
  ON board_manager_followups (response_hive_context_entry_id, account_id)
  WHERE response_hive_context_entry_id <> '';

CREATE TABLE IF NOT EXISTS network_task_intents (
  id text PRIMARY KEY,
  semantic_key text NOT NULL DEFAULT '',
  project_id text NOT NULL REFERENCES network_projects(id) ON DELETE CASCADE,
  task_class text NOT NULL DEFAULT 'network',
  candidate_account_id text NOT NULL DEFAULT '',
  candidate_wallet_address text NOT NULL DEFAULT '',
  normalized_need_hash text NOT NULL DEFAULT '',
  project_need_summary text NOT NULL DEFAULT '',
  routing_reason_summary text NOT NULL DEFAULT '',
  reward_min_pft numeric(20, 6) NOT NULL DEFAULT 10000,
  reward_max_pft numeric(20, 6) NOT NULL DEFAULT 50000,
  status text NOT NULL DEFAULT 'queued',
  allocation_id text NOT NULL DEFAULT '',
  generation_job_id text NOT NULL DEFAULT '',
  request_id text NOT NULL DEFAULT '',
  task_id text NOT NULL DEFAULT '',
  source_state_digest text NOT NULL DEFAULT '',
  created_by_run_id text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_task_intents_class_chk
    CHECK (task_class IN ('network', 'alpha')),
  CONSTRAINT network_task_intents_status_chk
    CHECK (status IN ('queued', 'generated', 'published', 'active', 'completed', 'rewarded', 'rejected', 'stopped', 'failed', 'suppressed', 'stale'))
);

CREATE UNIQUE INDEX IF NOT EXISTS network_task_intents_semantic_key_idx
  ON network_task_intents (semantic_key)
  WHERE semantic_key <> '';

CREATE INDEX IF NOT EXISTS network_task_intents_project_candidate_idx
  ON network_task_intents (project_id, candidate_account_id, candidate_wallet_address, task_class, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS network_task_intents_open_need_idx
  ON network_task_intents (project_id, normalized_need_hash, status, updated_at DESC)
  WHERE status NOT IN ('stale', 'failed');
