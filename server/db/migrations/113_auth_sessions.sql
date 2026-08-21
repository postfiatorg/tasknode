CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash text PRIMARY KEY,
  account_id text NOT NULL,
  primary_provider text NOT NULL DEFAULT '',
  assurance text NOT NULL DEFAULT 'low',
  session_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS auth_sessions_account_active_idx
  ON auth_sessions (account_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx
  ON auth_sessions (expires_at)
  WHERE revoked_at IS NULL;
