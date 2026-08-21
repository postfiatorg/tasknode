CREATE TABLE IF NOT EXISTS terminal_auth_requests (
  request_hash text PRIMARY KEY,
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  user_code text NOT NULL,
  poll_token_hash text NOT NULL,
  account_id text,
  request_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  consumed_at timestamptz
);

CREATE INDEX IF NOT EXISTS terminal_auth_requests_expiry_idx
  ON terminal_auth_requests (expires_at);

CREATE TABLE IF NOT EXISTS terminal_sessions (
  token_hash text PRIMARY KEY,
  session_id text NOT NULL UNIQUE,
  account_id text NOT NULL,
  provider text NOT NULL,
  provider_username text NOT NULL DEFAULT '',
  scopes_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  session_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS terminal_sessions_account_idx
  ON terminal_sessions (account_id, expires_at);
