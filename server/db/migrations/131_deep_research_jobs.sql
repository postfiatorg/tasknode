CREATE TABLE IF NOT EXISTS deep_research_jobs (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  conversation_id text NOT NULL,
  request_id text NOT NULL,
  question_message_id text NOT NULL,
  assistant_message_id text NOT NULL,
  question text NOT NULL,
  title text NOT NULL DEFAULT '',
  gateway_job_id text,
  status text NOT NULL DEFAULT 'starting',
  stage text NOT NULL DEFAULT 'starting',
  usage_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  progress_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (account_id, request_id)
);

CREATE INDEX IF NOT EXISTS deep_research_jobs_account_recent_idx
  ON deep_research_jobs (account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS deep_research_jobs_gateway_idx
  ON deep_research_jobs (gateway_job_id)
  WHERE gateway_job_id IS NOT NULL;
