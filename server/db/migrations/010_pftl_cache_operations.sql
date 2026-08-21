CREATE INDEX IF NOT EXISTS pftl_sync_wallets_archive_due_idx
  ON pftl_sync_wallets (status, priority, last_archive_sync_at, updated_at DESC, wallet_address)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS pftl_cache_reducer_events_completed_retention_idx
  ON pftl_cache_reducer_events (processed_at, id)
  WHERE status = 'completed';

CREATE TABLE IF NOT EXISTS pftl_cache_maintenance_runs (
  id bigserial PRIMARY KEY,
  run_kind text NOT NULL,
  status text NOT NULL DEFAULT 'completed',
  wallet_address text NOT NULL DEFAULT '',
  metrics_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text NOT NULL DEFAULT '',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS pftl_cache_maintenance_runs_kind_recent_idx
  ON pftl_cache_maintenance_runs (run_kind, started_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS pftl_cache_maintenance_runs_status_idx
  ON pftl_cache_maintenance_runs (status, started_at DESC)
  WHERE status <> 'completed';
