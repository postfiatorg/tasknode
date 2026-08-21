CREATE TABLE IF NOT EXISTS profile_public_snapshots (
  snapshot_id text PRIMARY KEY,
  account_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  input_fingerprint text NOT NULL DEFAULT '',
  input_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  role_title text NOT NULL DEFAULT '',
  role_summary text NOT NULL DEFAULT '',
  skills jsonb NOT NULL DEFAULT '[]'::jsonb,
  archetype text NOT NULL DEFAULT '',
  archetype_contrast text NOT NULL DEFAULT '',
  useful_to text NOT NULL DEFAULT '',
  data_caveat text NOT NULL DEFAULT '',
  provider text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  prompt_version text NOT NULL DEFAULT '',
  prompt_digest text NOT NULL DEFAULT '',
  output_digest text NOT NULL DEFAULT '',
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profile_public_snapshots_status_chk
    CHECK (status IN ('pending', 'running', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS profile_public_snapshots_account_recent_idx
  ON profile_public_snapshots (account_id, completed_at DESC NULLS LAST, updated_at DESC);

CREATE INDEX IF NOT EXISTS profile_public_snapshots_account_status_recent_idx
  ON profile_public_snapshots (account_id, status, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS profile_public_snapshots_completed_fingerprint_unique
  ON profile_public_snapshots (account_id, input_fingerprint)
  WHERE status = 'completed';
