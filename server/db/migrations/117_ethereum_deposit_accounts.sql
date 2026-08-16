CREATE TABLE IF NOT EXISTS ethereum_deposit_accounts (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  chain_id integer NOT NULL DEFAULT 1,
  network text NOT NULL DEFAULT 'Ethereum mainnet',
  address text NOT NULL UNIQUE,
  address_key text NOT NULL UNIQUE,
  derivation_index bigint NOT NULL UNIQUE,
  derivation_path text NOT NULL DEFAULT '',
  assets_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active',
  custody text NOT NULL DEFAULT 'tasknode_deposit_only',
  withdrawals_enabled boolean NOT NULL DEFAULT false,
  sweep_status text NOT NULL DEFAULT 'deferred',
  observed_balances_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  pending_balances_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  credited_balances_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at timestamptz,
  last_sync_status text NOT NULL DEFAULT 'not_synced',
  last_sync_error text NOT NULL DEFAULT '',
  last_sync_block_tag text NOT NULL DEFAULT '',
  last_credited_ledger_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  retire_reason text NOT NULL DEFAULT '',
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ethereum_deposit_accounts_active_account_idx
  ON ethereum_deposit_accounts (account_id)
  WHERE retired_at IS NULL;

CREATE INDEX IF NOT EXISTS ethereum_deposit_accounts_retention_idx
  ON ethereum_deposit_accounts (retired_at)
  WHERE retired_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS ethereum_deposit_allocator (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  next_derivation_index bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ethereum_deposit_allocator (singleton, next_derivation_index)
VALUES (true, 0)
ON CONFLICT (singleton) DO NOTHING;
