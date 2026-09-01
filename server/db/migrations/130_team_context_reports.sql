CREATE TABLE IF NOT EXISTS team_context_preferences (
  account_id text PRIMARY KEY,
  include_in_personal_context boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_context_reports (
  account_id text PRIMARY KEY,
  source_fingerprint text NOT NULL,
  source_packet_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  report_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  prompt_version text NOT NULL DEFAULT '',
  usage_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  generated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_context_jobs (
  account_id text PRIMARY KEY,
  source_fingerprint text NOT NULL,
  source_packet_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT team_context_jobs_status_chk
    CHECK (status IN ('pending', 'processing', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS team_context_jobs_claim_idx
  ON team_context_jobs (status, next_attempt_at, updated_at, account_id);

CREATE INDEX IF NOT EXISTS task_history_grants_team_context_fanout_idx
  ON task_history_grants (subject_account_id, viewer_account_id)
  WHERE scope = 'task_history_v1' AND status = 'active';
