ALTER TABLE profile_daily_airdrop_issuances
  DROP CONSTRAINT IF EXISTS profile_daily_airdrop_issuances_status_chk;

ALTER TABLE profile_daily_airdrop_issuances
  ADD CONSTRAINT profile_daily_airdrop_issuances_status_chk
    CHECK (status IN ('pending', 'processing', 'submitted', 'failed'));

CREATE INDEX IF NOT EXISTS profile_daily_airdrop_issuances_processing_idx
  ON profile_daily_airdrop_issuances (status, updated_at DESC, run_id)
  WHERE status = 'processing';
