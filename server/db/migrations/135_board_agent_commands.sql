CREATE TABLE IF NOT EXISTS board_agent_credentials (
  id text PRIMARY KEY,
  token_hash text UNIQUE NOT NULL,
  actor text NOT NULL,
  board_ids jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS board_agent_commands (
  credential_id text NOT NULL REFERENCES board_agent_credentials(id),
  request_key text NOT NULL,
  input_digest text NOT NULL,
  command text NOT NULL,
  result_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (credential_id, request_key)
);
CREATE TABLE IF NOT EXISTS board_agent_rounds (
  id text PRIMARY KEY,
  actor text NOT NULL,
  board_ids jsonb NOT NULL,
  duties_json jsonb NOT NULL,
  results_json jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
