CREATE TABLE IF NOT EXISTS profile_nft_daily_awards (
  id text PRIMARY KEY,
  run_date date NOT NULL,
  account_id text NOT NULL,
  wallet_address text NOT NULL DEFAULT '',
  profile_nft_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  eligibility_reason text NOT NULL DEFAULT '',
  personal_completed_count integer NOT NULL DEFAULT 0,
  network_completed_count integer NOT NULL DEFAULT 0,
  eligibility_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt_count integer NOT NULL DEFAULT 0,
  error text NOT NULL DEFAULT '',
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profile_nft_daily_awards_status_chk
    CHECK (status IN ('pending', 'running', 'generated', 'failed', 'skipped'))
);

CREATE UNIQUE INDEX IF NOT EXISTS profile_nft_daily_awards_account_day_idx
  ON profile_nft_daily_awards (run_date, account_id);

CREATE INDEX IF NOT EXISTS profile_nft_daily_awards_status_recent_idx
  ON profile_nft_daily_awards (status, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS profile_nft_daily_awards_wallet_recent_idx
  ON profile_nft_daily_awards (wallet_address, run_date DESC)
  WHERE wallet_address <> '';
