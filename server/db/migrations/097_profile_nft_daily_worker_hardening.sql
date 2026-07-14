ALTER TABLE profile_nft_daily_awards
  ADD COLUMN IF NOT EXISTS error_code text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS retryable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

ALTER TABLE profile_nft_daily_awards
  DROP CONSTRAINT IF EXISTS profile_nft_daily_awards_status_chk;

ALTER TABLE profile_nft_daily_awards
  ADD CONSTRAINT profile_nft_daily_awards_status_chk
  CHECK (status IN ('pending', 'running', 'generated', 'failed', 'retry_wait', 'failed_permanent', 'skipped'));

CREATE INDEX IF NOT EXISTS profile_nft_daily_awards_retry_idx
  ON profile_nft_daily_awards (status, next_attempt_at, updated_at DESC, id)
  WHERE status = 'retry_wait';

CREATE TABLE IF NOT EXISTS profile_nft_daily_worker_heartbeats (
  worker_key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  generation_gated boolean NOT NULL DEFAULT true,
  dry_run boolean NOT NULL DEFAULT false,
  last_tick_started_at timestamptz,
  last_tick_finished_at timestamptz,
  last_success_at timestamptz,
  last_error_code text NOT NULL DEFAULT '',
  last_error_message text NOT NULL DEFAULT '',
  retryable_count integer NOT NULL DEFAULT 0,
  permanent_count integer NOT NULL DEFAULT 0,
  current_retry_award_id text NOT NULL DEFAULT '',
  next_retry_at timestamptz,
  candidate_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
