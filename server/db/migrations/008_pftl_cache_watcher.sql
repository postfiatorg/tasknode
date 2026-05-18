CREATE TABLE IF NOT EXISTS pftl_cache_watcher_state (
  id text PRIMARY KEY,
  endpoint_url text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'idle',
  subscribed_wallet_count integer NOT NULL DEFAULT 0,
  last_ledger_index bigint,
  last_event_tx_hash text,
  last_event_at timestamptz,
  last_error text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pftl_cache_reducer_events (
  id bigserial PRIMARY KEY,
  dedupe_key text NOT NULL DEFAULT '',
  wallet_address text NOT NULL,
  account_id text NOT NULL DEFAULT '',
  tx_hash text NOT NULL,
  ledger_index bigint,
  reducer_kind text NOT NULL,
  pointer_kind text,
  cid text,
  task_id text,
  context_id text,
  memo_index integer,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'pftl_cache_watcher',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  available_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pftl_cache_reducer_events_dedupe_idx
  ON pftl_cache_reducer_events (dedupe_key);

CREATE INDEX IF NOT EXISTS pftl_cache_reducer_events_pending_idx
  ON pftl_cache_reducer_events (status, available_at, id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS pftl_cache_reducer_events_wallet_recent_idx
  ON pftl_cache_reducer_events (wallet_address, created_at DESC, id);

CREATE INDEX IF NOT EXISTS pftl_cache_reducer_events_task_idx
  ON pftl_cache_reducer_events (task_id, status, created_at DESC)
  WHERE task_id IS NOT NULL;
