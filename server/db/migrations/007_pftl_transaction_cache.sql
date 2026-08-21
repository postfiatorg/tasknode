CREATE TABLE IF NOT EXISTS pftl_sync_wallets (
  wallet_address text PRIMARY KEY,
  account_id text,
  role text NOT NULL DEFAULT 'user',
  owner_wallet_address text,
  status text NOT NULL DEFAULT 'active',
  priority integer NOT NULL DEFAULT 100,
  last_seen_tx_hash text,
  last_seen_ledger bigint,
  last_checked_at timestamptz,
  last_hot_sync_at timestamptz,
  last_archive_sync_at timestamptz,
  archive_marker jsonb,
  last_archive_ledger bigint,
  last_error text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pftl_sync_wallets_status_priority_idx
  ON pftl_sync_wallets (status, priority, updated_at DESC, wallet_address);

CREATE INDEX IF NOT EXISTS pftl_sync_wallets_account_idx
  ON pftl_sync_wallets (account_id, status, wallet_address)
  WHERE account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pftl_transactions (
  tx_hash text PRIMARY KEY,
  ledger_index bigint,
  tx_type text,
  validated boolean,
  account text,
  destination text,
  transaction_result text,
  close_time timestamptz,
  tx_json jsonb NOT NULL,
  meta_json jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pftl_transactions_ledger_idx
  ON pftl_transactions (ledger_index DESC NULLS LAST, tx_hash);

CREATE INDEX IF NOT EXISTS pftl_transactions_account_idx
  ON pftl_transactions (account, ledger_index DESC NULLS LAST)
  WHERE account IS NOT NULL;

CREATE INDEX IF NOT EXISTS pftl_transactions_destination_idx
  ON pftl_transactions (destination, ledger_index DESC NULLS LAST)
  WHERE destination IS NOT NULL;

CREATE TABLE IF NOT EXISTS pftl_wallet_transactions (
  wallet_address text NOT NULL,
  tx_hash text NOT NULL REFERENCES pftl_transactions(tx_hash) ON DELETE CASCADE,
  direction text,
  counterparty_wallet text,
  delivered_drops text,
  fee_drops text,
  ledger_index bigint,
  close_time timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet_address, tx_hash)
);

CREATE INDEX IF NOT EXISTS pftl_wallet_transactions_wallet_recent_idx
  ON pftl_wallet_transactions (wallet_address, ledger_index DESC NULLS LAST, close_time DESC NULLS LAST, tx_hash);

CREATE INDEX IF NOT EXISTS pftl_wallet_transactions_counterparty_idx
  ON pftl_wallet_transactions (counterparty_wallet, wallet_address)
  WHERE counterparty_wallet IS NOT NULL;

CREATE TABLE IF NOT EXISTS pftl_pointer_memos (
  tx_hash text NOT NULL REFERENCES pftl_transactions(tx_hash) ON DELETE CASCADE,
  memo_index integer NOT NULL,
  wallet_address text,
  memo_type text,
  memo_format text,
  pointer_kind text,
  schema_version text,
  cid text,
  task_id text,
  request_id text,
  context_id text,
  thread_id text,
  memo_data_hex text NOT NULL,
  decoded_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  decode_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tx_hash, memo_index)
);

CREATE INDEX IF NOT EXISTS pftl_pointer_memos_wallet_kind_recent_idx
  ON pftl_pointer_memos (wallet_address, pointer_kind, created_at DESC)
  WHERE wallet_address IS NOT NULL;

CREATE INDEX IF NOT EXISTS pftl_pointer_memos_cid_idx
  ON pftl_pointer_memos (cid)
  WHERE cid IS NOT NULL;

CREATE INDEX IF NOT EXISTS pftl_pointer_memos_task_idx
  ON pftl_pointer_memos (task_id, tx_hash)
  WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS pftl_pointer_memos_context_idx
  ON pftl_pointer_memos (context_id, tx_hash)
  WHERE context_id IS NOT NULL;
