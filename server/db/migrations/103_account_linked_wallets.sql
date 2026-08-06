-- Durable mirror of account wallet links. The runtime store on the Fly app
-- volume is the write path for wallet linking, but worker machines have no
-- volume, so routing decisions (network task generation) could not see the
-- current linked wallet and offered tasks to stale wallets. This table is
-- the cross-process source of truth for "which wallet does this account
-- currently follow"; it is written on every link/delink and backfilled from
-- the app machine's store.

CREATE TABLE IF NOT EXISTS account_linked_wallets (
  account_id text PRIMARY KEY,
  wallet_address text NOT NULL,
  status text NOT NULL DEFAULT 'linked',
  linked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_linked_wallets_wallet_idx
  ON account_linked_wallets (wallet_address);
