CREATE TABLE IF NOT EXISTS runtime_state_migrations (
  name text PRIMARY KEY,
  migrated_at timestamptz NOT NULL DEFAULT now(),
  record_count integer NOT NULL DEFAULT 0,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb
);
