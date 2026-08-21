ALTER TABLE context_rewrite_jobs
  ADD COLUMN IF NOT EXISTS source_packet_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS source_snapshot_at timestamptz,
  ADD COLUMN IF NOT EXISTS current_attempt_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS draft_markdown text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS draft_metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS max_cost_usd numeric(18, 6) NOT NULL DEFAULT 0;

ALTER TABLE context_rewrite_score_runs
  ADD COLUMN IF NOT EXISTS attempt_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS provider_call_id text NOT NULL DEFAULT '';

ALTER TABLE context_rewrite_search_results
  ADD COLUMN IF NOT EXISTS attempt_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS provider_call_id text NOT NULL DEFAULT '';

ALTER TABLE context_rewrite_artifacts
  ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS context_rewrite_provider_calls (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES context_rewrite_jobs(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  attempt_id text NOT NULL DEFAULT '',
  stage text NOT NULL DEFAULT '',
  call_index integer NOT NULL DEFAULT 0,
  provider text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'running',
  request_digest text NOT NULL DEFAULT '',
  response_id text,
  usage_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_usd numeric(18, 6) NOT NULL DEFAULT 0,
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  annotations_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_text_excerpt text NOT NULL DEFAULT '',
  error text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  timeout_at timestamptz,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS context_rewrite_jobs_running_lock_idx
  ON context_rewrite_jobs (status, locked_at ASC, updated_at ASC, id)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS context_rewrite_provider_calls_job_stage_idx
  ON context_rewrite_provider_calls (job_id, stage, call_index, created_at DESC);

CREATE INDEX IF NOT EXISTS context_rewrite_provider_calls_status_heartbeat_idx
  ON context_rewrite_provider_calls (status, heartbeat_at ASC, timeout_at ASC, id)
  WHERE status = 'running';

CREATE UNIQUE INDEX IF NOT EXISTS context_rewrite_provider_calls_attempt_stage_idx
  ON context_rewrite_provider_calls (job_id, attempt_id, stage, call_index);

CREATE INDEX IF NOT EXISTS context_rewrite_score_runs_provider_call_idx
  ON context_rewrite_score_runs (provider_call_id)
  WHERE provider_call_id <> '';

CREATE INDEX IF NOT EXISTS context_rewrite_search_results_provider_call_idx
  ON context_rewrite_search_results (provider_call_id)
  WHERE provider_call_id <> '';

WITH latest AS (
  SELECT DISTINCT ON (job_id)
    id
  FROM context_rewrite_artifacts
  WHERE artifact_type = 'final_markdown'
  ORDER BY job_id, created_at DESC, id DESC
)
UPDATE context_rewrite_artifacts artifact
SET is_current = artifact.id IN (SELECT id FROM latest)
WHERE artifact.artifact_type = 'final_markdown';

CREATE UNIQUE INDEX IF NOT EXISTS context_rewrite_artifacts_current_final_idx
  ON context_rewrite_artifacts (job_id, artifact_type)
  WHERE artifact_type = 'final_markdown' AND is_current = true;
