CREATE TABLE IF NOT EXISTS board_manager_capability_profiles (
  id text PRIMARY KEY,
  account_id text NOT NULL DEFAULT '',
  project_id text NOT NULL DEFAULT '',
  capability_type text NOT NULL DEFAULT '',
  scope_label text NOT NULL DEFAULT '',
  scope_digest text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'declared',
  evidence_task_id text NOT NULL DEFAULT '',
  evidence_url_or_ref text NOT NULL DEFAULT '',
  verified_by text NOT NULL DEFAULT '',
  verified_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  notes text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT board_manager_capability_profiles_status_chk
    CHECK (status IN ('declared', 'verifying', 'verified', 'expired', 'revoked'))
);

CREATE UNIQUE INDEX IF NOT EXISTS board_manager_capability_profiles_scope_idx
  ON board_manager_capability_profiles (account_id, project_id, capability_type, scope_digest);

CREATE INDEX IF NOT EXISTS board_manager_capability_profiles_account_status_idx
  ON board_manager_capability_profiles (account_id, status, updated_at DESC)
  WHERE account_id <> '';

CREATE INDEX IF NOT EXISTS board_manager_capability_profiles_project_type_idx
  ON board_manager_capability_profiles (project_id, capability_type, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS board_manager_capability_profiles_evidence_task_idx
  ON board_manager_capability_profiles (evidence_task_id)
  WHERE evidence_task_id <> '';
