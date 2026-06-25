CREATE TABLE IF NOT EXISTS context_rewrite_jobs (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  conversation_id text NOT NULL,
  instruction_message_id text NOT NULL,
  assistant_message_id text NOT NULL,
  instruction_text text NOT NULL DEFAULT '',
  base_context_revision integer NOT NULL DEFAULT 0,
  base_body_sha256 text NOT NULL DEFAULT '',
  source_packet_digest text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'queued',
  current_stage text NOT NULL DEFAULT 'queued',
  estimate_cost_usd numeric(18, 6) NOT NULL DEFAULT 0,
  actual_cost_usd numeric(18, 6) NOT NULL DEFAULT 0,
  aggregate_score_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  jobs_retrieval_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  final_artifact_id text,
  final_markdown text NOT NULL DEFAULT '',
  final_metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  progress_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  retry_count integer NOT NULL DEFAULT 0,
  locked_at timestamptz,
  locked_by text,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS context_rewrite_jobs_account_recent_idx
  ON context_rewrite_jobs (account_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS context_rewrite_jobs_status_idx
  ON context_rewrite_jobs (status, queued_at ASC, id);

CREATE INDEX IF NOT EXISTS context_rewrite_jobs_conversation_idx
  ON context_rewrite_jobs (account_id, conversation_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS context_rewrite_score_runs (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES context_rewrite_jobs(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  provider text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  model_family text NOT NULL DEFAULT '',
  run_index integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'queued',
  prompt_digest text NOT NULL DEFAULT '',
  parsed_score_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_text_excerpt text NOT NULL DEFAULT '',
  usage_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_usd numeric(18, 6) NOT NULL DEFAULT 0,
  response_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS context_rewrite_score_runs_job_idx
  ON context_rewrite_score_runs (job_id, model_family, run_index);

CREATE TABLE IF NOT EXISTS context_rewrite_search_results (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES context_rewrite_jobs(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  query_index integer NOT NULL DEFAULT 0,
  query_text text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'queued',
  provider text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  response_id text,
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  usage_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_usd numeric(18, 6) NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS context_rewrite_search_results_job_idx
  ON context_rewrite_search_results (job_id, query_index);

CREATE TABLE IF NOT EXISTS context_rewrite_artifacts (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES context_rewrite_jobs(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  artifact_type text NOT NULL DEFAULT 'final_markdown',
  source_packet_digest text NOT NULL DEFAULT '',
  markdown text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS context_rewrite_artifacts_job_idx
  ON context_rewrite_artifacts (job_id, artifact_type, created_at DESC);
