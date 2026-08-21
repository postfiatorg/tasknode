CREATE TABLE IF NOT EXISTS network_task_profile_jobs (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  reason text NOT NULL DEFAULT '',
  source_packet_digest text NOT NULL DEFAULT '',
  source_packet_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_packet_text text NOT NULL DEFAULT '',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS network_task_profile_jobs_status_idx
  ON network_task_profile_jobs (status, next_attempt_at, created_at, id);

CREATE INDEX IF NOT EXISTS network_task_profile_jobs_account_recent_idx
  ON network_task_profile_jobs (account_id, updated_at DESC, id);

CREATE UNIQUE INDEX IF NOT EXISTS network_task_profile_jobs_active_digest_idx
  ON network_task_profile_jobs (account_id, source_packet_digest)
  WHERE status IN ('pending', 'processing');

CREATE TABLE IF NOT EXISTS network_task_profiles (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  status text NOT NULL DEFAULT 'completed',
  source_packet_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_packet_text text NOT NULL DEFAULT '',
  source_packet_digest text NOT NULL DEFAULT '',
  output_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_text text NOT NULL DEFAULT '',
  provider text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  prompt_version text NOT NULL DEFAULT 'network_task_profile_v1',
  prompt_digest text NOT NULL DEFAULT '',
  usage_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  superseded_at timestamptz
);

CREATE INDEX IF NOT EXISTS network_task_profiles_account_recent_idx
  ON network_task_profiles (account_id, completed_at DESC NULLS LAST, created_at DESC, id);

CREATE INDEX IF NOT EXISTS network_task_profiles_account_active_idx
  ON network_task_profiles (account_id, superseded_at, completed_at DESC NULLS LAST)
  WHERE status = 'completed';
