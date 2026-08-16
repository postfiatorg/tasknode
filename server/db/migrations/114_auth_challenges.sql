CREATE TABLE IF NOT EXISTS auth_challenges (
  challenge_hash text PRIMARY KEY,
  kind text NOT NULL,
  provider text NOT NULL DEFAULT '',
  subject_key text NOT NULL DEFAULT '',
  secret_hash text NOT NULL DEFAULT '',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  replaced_at timestamptz
);

CREATE INDEX IF NOT EXISTS auth_challenges_active_subject_idx
  ON auth_challenges (kind, subject_key, created_at DESC)
  WHERE consumed_at IS NULL AND replaced_at IS NULL;

CREATE INDEX IF NOT EXISTS auth_challenges_expiry_idx
  ON auth_challenges (expires_at);
