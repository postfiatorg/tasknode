ALTER TABLE profile_daily_airdrop_issuances
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error_code text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS last_error_message text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS submission_attempted_at timestamptz,
  ADD COLUMN IF NOT EXISTS signed_tx_hash text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS reconciliation_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS reconciled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

ALTER TABLE profile_daily_airdrop_issuances
  DROP CONSTRAINT IF EXISTS profile_daily_airdrop_issuances_status_chk;

UPDATE profile_daily_airdrop_issuances
   SET status = CASE
         WHEN status = 'processing' AND COALESCE(error_message, '') <> '' THEN 'submit_unknown'
         WHEN status = 'processing' THEN 'processing_pre_submit'
         WHEN status = 'failed'
              AND COALESCE(tx_hash, '') = ''
              AND submitted_at IS NULL THEN 'failed_before_submit'
         ELSE status
       END,
       last_error_message = CASE
         WHEN COALESCE(last_error_message, '') = '' THEN COALESCE(error_message, '')
         ELSE last_error_message
       END,
       last_error_code = CASE
         WHEN status = 'failed'
              AND COALESCE(tx_hash, '') = ''
              AND submitted_at IS NULL
              AND COALESCE(last_error_code, '') = '' THEN 'legacy_failed_before_submit'
         WHEN status = 'processing'
              AND COALESCE(error_message, '') <> ''
              AND COALESCE(last_error_code, '') = '' THEN 'legacy_submit_unknown'
         ELSE last_error_code
       END,
       updated_at = now()
 WHERE status IN ('processing', 'failed');

ALTER TABLE profile_daily_airdrop_issuances
  ADD CONSTRAINT profile_daily_airdrop_issuances_status_chk
    CHECK (status IN (
      'pending',
      'processing',
      'processing_pre_submit',
      'failed',
      'failed_before_submit',
      'submitting',
      'submit_unknown',
      'submitted',
      'cancelled'
    ));

CREATE INDEX IF NOT EXISTS profile_daily_airdrop_issuances_retry_idx
  ON profile_daily_airdrop_issuances (status, run_date, updated_at, run_id)
  WHERE status IN ('pending', 'failed', 'failed_before_submit', 'processing_pre_submit', 'submitting', 'submit_unknown');

CREATE INDEX IF NOT EXISTS profile_daily_airdrop_issuances_signed_tx_hash_idx
  ON profile_daily_airdrop_issuances (signed_tx_hash)
  WHERE signed_tx_hash <> '';
