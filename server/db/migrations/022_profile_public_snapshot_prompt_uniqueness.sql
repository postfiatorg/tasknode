DROP INDEX IF EXISTS profile_public_snapshots_completed_fingerprint_unique;

CREATE UNIQUE INDEX IF NOT EXISTS profile_public_snapshots_completed_prompt_fingerprint_unique
  ON profile_public_snapshots (account_id, input_fingerprint, prompt_digest, model)
  WHERE status = 'completed';
