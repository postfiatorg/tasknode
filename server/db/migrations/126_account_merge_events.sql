CREATE TABLE IF NOT EXISTS account_merge_events (
  id text PRIMARY KEY,
  source_account_id text NOT NULL,
  target_account_id text NOT NULL,
  actor_account_id text NOT NULL DEFAULT '',
  actor_operator text NOT NULL DEFAULT '',
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'completed',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_account_id, target_account_id)
);

CREATE INDEX IF NOT EXISTS account_merge_events_target_recent_idx
  ON account_merge_events (target_account_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS account_merge_events_source_recent_idx
  ON account_merge_events (source_account_id, created_at DESC, id);
