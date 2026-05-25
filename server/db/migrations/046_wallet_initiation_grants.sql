CREATE TABLE IF NOT EXISTS wallet_initiation_grants (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  wallet_address text NOT NULL,
  source text NOT NULL DEFAULT 'wallet_create',
  amount_pft numeric(18, 6) NOT NULL,
  amount_drops text NOT NULL,
  status text NOT NULL DEFAULT 'processing',
  tx_hash text NOT NULL DEFAULT '',
  faucet_address text NOT NULL DEFAULT '',
  trigger_json jsonb,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_initiation_grants_status_chk
    CHECK (status IN ('processing', 'completed', 'unknown', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS wallet_initiation_grants_account_active_unique
  ON wallet_initiation_grants (account_id)
  WHERE status IN ('processing', 'completed', 'unknown');

CREATE UNIQUE INDEX IF NOT EXISTS wallet_initiation_grants_wallet_active_unique
  ON wallet_initiation_grants (wallet_address)
  WHERE status IN ('processing', 'completed', 'unknown');

CREATE INDEX IF NOT EXISTS wallet_initiation_grants_account_recent_idx
  ON wallet_initiation_grants (account_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS wallet_initiation_grants_wallet_recent_idx
  ON wallet_initiation_grants (wallet_address, updated_at DESC);
