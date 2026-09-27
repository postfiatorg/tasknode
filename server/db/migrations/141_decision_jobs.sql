CREATE TABLE IF NOT EXISTS decision_jobs (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  conversation_id text NOT NULL,
  request_id text NOT NULL,
  request_fingerprint text NOT NULL,
  question_message_id text NOT NULL,
  assistant_message_id text NOT NULL,
  input text NOT NULL,
  context_included boolean NOT NULL DEFAULT false,
  gateway_job_id text,
  status text NOT NULL DEFAULT 'starting',
  stage text NOT NULL DEFAULT 'starting',
  progress_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  report_markdown text NOT NULL DEFAULT '',
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (account_id, request_id)
);
CREATE INDEX IF NOT EXISTS decision_jobs_account_recent_idx ON decision_jobs(account_id, created_at DESC);
