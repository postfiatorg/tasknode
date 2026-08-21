-- Durable account wallet links. Migration 115 adds proof and encryption-key
-- metadata; production reads and writes this table transactionally. The JSON
-- runtime implementation remains only as the no-database development adapter.

CREATE TABLE IF NOT EXISTS account_linked_wallets (
  account_id text PRIMARY KEY,
  wallet_address text NOT NULL,
  status text NOT NULL DEFAULT 'linked',
  linked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_linked_wallets_wallet_idx
  ON account_linked_wallets (wallet_address);
