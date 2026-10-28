CREATE TABLE validator_connect_tokens (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  account_id text NOT NULL,
  challenge text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  binding_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX validator_connect_tokens_account ON validator_connect_tokens(account_id, created_at DESC);

-- Provider choice survives retries, account binding changes and process restarts.
ALTER TABLE deep_research_jobs ADD COLUMN provider text NOT NULL DEFAULT 'corbanu'
  CHECK (provider IN ('corbanu', 'goodalexander'));
ALTER TABLE deep_research_jobs ADD COLUMN max_cost_usd numeric(18,6);
