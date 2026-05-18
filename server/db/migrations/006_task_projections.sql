CREATE TABLE IF NOT EXISTS pftl_task_sync_runs (
  id text PRIMARY KEY,
  account_id text NOT NULL DEFAULT '',
  wallet_address text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'pftl_replay',
  source_ref text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'completed',
  task_count integer NOT NULL DEFAULT 0,
  pointer_event_count integer NOT NULL DEFAULT 0,
  error text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pftl_task_sync_runs_account_wallet_recent_idx
  ON pftl_task_sync_runs (account_id, wallet_address, created_at DESC, id);

CREATE TABLE IF NOT EXISTS pftl_task_pointer_events (
  id text PRIMARY KEY,
  sync_run_id text REFERENCES pftl_task_sync_runs (id) ON DELETE SET NULL,
  account_id text NOT NULL DEFAULT '',
  wallet_address text NOT NULL DEFAULT '',
  task_id text,
  event_schema text NOT NULL DEFAULT '',
  pointer_kind text NOT NULL DEFAULT '',
  source_tx_hash text NOT NULL,
  source_cid text NOT NULL,
  ledger_index bigint,
  memo_index integer NOT NULL DEFAULT 0,
  event_digest text NOT NULL DEFAULT '',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  pointer_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'pftl_replay',
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pftl_task_pointer_events_dedupe_idx
  ON pftl_task_pointer_events (
    account_id,
    wallet_address,
    source_tx_hash,
    memo_index,
    source_cid
  );

CREATE INDEX IF NOT EXISTS pftl_task_pointer_events_task_recent_idx
  ON pftl_task_pointer_events (task_id, observed_at DESC, id);

CREATE TABLE IF NOT EXISTS task_events (
  id text PRIMARY KEY,
  task_id text NOT NULL,
  account_id text NOT NULL DEFAULT '',
  wallet_address text NOT NULL DEFAULT '',
  event_type text NOT NULL,
  source_tx_hash text NOT NULL,
  source_cid text NOT NULL,
  event_digest text NOT NULL DEFAULT '',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  pointer_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS task_events_dedupe_idx
  ON task_events (task_id, event_type, source_tx_hash, source_cid);

CREATE INDEX IF NOT EXISTS task_events_account_wallet_recent_idx
  ON task_events (account_id, wallet_address, occurred_at DESC, id);

CREATE TABLE IF NOT EXISTS task_projections (
  task_id text PRIMARY KEY,
  account_id text NOT NULL DEFAULT '',
  subject_wallet text NOT NULL DEFAULT '',
  authority_wallet text NOT NULL DEFAULT '',
  allocation_wallet text NOT NULL DEFAULT '',
  request_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'unknown',
  title text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  task_kind text NOT NULL DEFAULT '',
  reward_offer_pft numeric(18, 6) NOT NULL DEFAULT 0,
  reward_actual_pft numeric(18, 6) NOT NULL DEFAULT 0,
  request_bundle_cid text NOT NULL DEFAULT '',
  context_cid text NOT NULL DEFAULT '',
  submission_type text NOT NULL DEFAULT '',
  submission_requirement_text text NOT NULL DEFAULT '',
  verification_policy_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  accept_by timestamptz,
  deadline_at timestamptz,
  event_count integer NOT NULL DEFAULT 0,
  last_event_tx_hash text NOT NULL DEFAULT '',
  last_event_cid text NOT NULL DEFAULT '',
  last_event_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'pftl_replay',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_projections_account_status_recent_idx
  ON task_projections (account_id, status, updated_at DESC, task_id);

CREATE INDEX IF NOT EXISTS task_projections_wallet_status_recent_idx
  ON task_projections (subject_wallet, status, updated_at DESC, task_id);
