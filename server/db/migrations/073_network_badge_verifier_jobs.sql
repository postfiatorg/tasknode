CREATE TABLE IF NOT EXISTS network_badge_verifier_jobs (
  id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  account_id text NOT NULL DEFAULT '',
  badge_id text NOT NULL DEFAULT '',
  provider text NOT NULL DEFAULT '',
  verifier_type text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'queued',
  input_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text NOT NULL DEFAULT '',
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  requested_by_account_id text NOT NULL DEFAULT '',
  requested_by_operator text NOT NULL DEFAULT '',
  run_after timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS network_badge_verifier_jobs_status_run_idx
  ON network_badge_verifier_jobs (status, run_after, updated_at DESC);

CREATE INDEX IF NOT EXISTS network_badge_verifier_jobs_account_badge_idx
  ON network_badge_verifier_jobs (account_id, badge_id, updated_at DESC);
