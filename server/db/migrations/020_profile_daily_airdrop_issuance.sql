CREATE TABLE IF NOT EXISTS profile_daily_airdrop_issuances (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  run_id text NOT NULL REFERENCES profile_daily_airdrop_runs(id) ON DELETE CASCADE,
  run_date date NOT NULL,
  source_wallet text NOT NULL DEFAULT '',
  recipient_wallet text NOT NULL,
  amount_pft numeric(18, 6) NOT NULL,
  amount_drops text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  source_cid text NOT NULL DEFAULT '',
  tx_hash text NOT NULL DEFAULT '',
  ledger_index integer,
  payload_digest text NOT NULL DEFAULT '',
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT profile_daily_airdrop_issuances_status_chk
    CHECK (status IN ('pending', 'submitted', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS profile_daily_airdrop_issuances_run_unique
  ON profile_daily_airdrop_issuances (run_id);

CREATE UNIQUE INDEX IF NOT EXISTS profile_daily_airdrop_issuances_account_day_unique
  ON profile_daily_airdrop_issuances (account_id, run_date)
  WHERE status = 'submitted';

CREATE INDEX IF NOT EXISTS profile_daily_airdrop_issuances_account_recent_idx
  ON profile_daily_airdrop_issuances (account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS profile_daily_airdrop_issuances_recipient_recent_idx
  ON profile_daily_airdrop_issuances (recipient_wallet, created_at DESC);
