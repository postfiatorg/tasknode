CREATE TABLE IF NOT EXISTS hive_project_planning_jobs (
  id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'pending',
  reason text NOT NULL DEFAULT '',
  source_report_id text NOT NULL DEFAULT '',
  source_report_digest text NOT NULL DEFAULT '',
  source_packet_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_packet_text text NOT NULL DEFAULT '',
  prompt_version text NOT NULL DEFAULT '',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hive_project_planning_jobs_status_chk
    CHECK (status IN ('pending', 'processing', 'completed', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS hive_project_planning_jobs_source_prompt_unique
  ON hive_project_planning_jobs (source_report_id, prompt_version);

CREATE INDEX IF NOT EXISTS hive_project_planning_jobs_pending_idx
  ON hive_project_planning_jobs (status, next_attempt_at, created_at, id);

CREATE TABLE IF NOT EXISTS hive_project_generations (
  id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'completed',
  source_report_id text NOT NULL DEFAULT '',
  source_report_digest text NOT NULL DEFAULT '',
  source_packet_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_packet_text text NOT NULL DEFAULT '',
  output_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_text text NOT NULL DEFAULT '',
  provider text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  prompt_version text NOT NULL DEFAULT '',
  prompt_digest text NOT NULL DEFAULT '',
  response_id text NOT NULL DEFAULT '',
  usage_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hive_project_generations_status_chk
    CHECK (status IN ('completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS hive_project_generations_latest_idx
  ON hive_project_generations (completed_at DESC, created_at DESC, id)
  WHERE status = 'completed';
