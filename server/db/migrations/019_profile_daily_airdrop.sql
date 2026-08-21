CREATE TABLE IF NOT EXISTS profile_daily_airdrop_runs (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  run_date date NOT NULL,
  run_mode text NOT NULL DEFAULT 'dry_run',
  scenario_id text NOT NULL DEFAULT '',
  is_canonical boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending',
  daily_airdrop_pft numeric(18, 6) NOT NULL DEFAULT 0,
  retention_value_score integer NOT NULL DEFAULT 0,
  what_raised_today text,
  what_kept_it_lower text,
  to_improve_tomorrow text,
  eligibility_status text NOT NULL DEFAULT 'ineligible',
  eligibility_reason text,
  reasoning_text text,
  actual_airdrop_pft_7d numeric(18, 6) NOT NULL DEFAULT 0,
  max_possible_airdrop_pft_7d numeric(18, 6) NOT NULL DEFAULT 70000,
  alignment_score_7d numeric(12, 8) NOT NULL DEFAULT 0,
  input_hash text NOT NULL DEFAULT '',
  input_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  prompt_version text NOT NULL DEFAULT '',
  prompt_digest text NOT NULL DEFAULT '',
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT profile_daily_airdrop_runs_mode_chk
    CHECK (run_mode IN ('dry_run', 'production')),
  CONSTRAINT profile_daily_airdrop_runs_status_chk
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  CONSTRAINT profile_daily_airdrop_runs_eligibility_chk
    CHECK (eligibility_status IN ('eligible', 'ineligible'))
);

CREATE UNIQUE INDEX IF NOT EXISTS profile_daily_airdrop_runs_production_day_unique
  ON profile_daily_airdrop_runs (account_id, run_date)
  WHERE run_mode = 'production';

CREATE INDEX IF NOT EXISTS profile_daily_airdrop_runs_account_mode_recent_idx
  ON profile_daily_airdrop_runs (account_id, run_mode, created_at DESC);

CREATE INDEX IF NOT EXISTS profile_daily_airdrop_runs_account_recent_idx
  ON profile_daily_airdrop_runs (account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS profile_daily_airdrop_runs_status_created_idx
  ON profile_daily_airdrop_runs (status, created_at);
