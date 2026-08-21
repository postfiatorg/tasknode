CREATE TABLE IF NOT EXISTS pftl_pointer_observations (
  wallet_address text NOT NULL,
  tx_hash text NOT NULL,
  memo_index integer NOT NULL,
  account_id text NOT NULL DEFAULT '',
  wallet_role text NOT NULL DEFAULT '',
  direction text,
  pointer_kind text,
  cid text,
  task_id text,
  request_id text,
  context_id text,
  thread_id text,
  source text NOT NULL DEFAULT 'pftl_cache',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (wallet_address, tx_hash, memo_index),
  CONSTRAINT pftl_pointer_observations_pointer_fk
    FOREIGN KEY (tx_hash, memo_index)
    REFERENCES pftl_pointer_memos (tx_hash, memo_index)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS pftl_pointer_observations_account_task_idx
  ON pftl_pointer_observations (account_id, task_id, updated_at DESC, tx_hash, memo_index)
  WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS pftl_pointer_observations_account_context_idx
  ON pftl_pointer_observations (account_id, context_id, updated_at DESC, tx_hash, memo_index)
  WHERE context_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS pftl_pointer_observations_tx_memo_idx
  ON pftl_pointer_observations (tx_hash, memo_index, wallet_address);

CREATE INDEX IF NOT EXISTS pftl_pointer_observations_wallet_kind_recent_idx
  ON pftl_pointer_observations (wallet_address, pointer_kind, updated_at DESC, tx_hash)
  WHERE pointer_kind IS NOT NULL;
