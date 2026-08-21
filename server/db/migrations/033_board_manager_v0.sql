CREATE TABLE IF NOT EXISTS board_manager_leases (
  scope text PRIMARY KEY,
  manager_id text NOT NULL DEFAULT '',
  owner_instance text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'released',
  claimed_at timestamptz,
  heartbeat_at timestamptz,
  expires_at timestamptz,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT board_manager_leases_status_chk
    CHECK (status IN ('active', 'released', 'expired'))
);

CREATE INDEX IF NOT EXISTS board_manager_leases_expiry_idx
  ON board_manager_leases (status, expires_at, scope);

CREATE TABLE IF NOT EXISTS board_manager_runs (
  id text PRIMARY KEY,
  scope text NOT NULL DEFAULT 'global_hive',
  manager_id text NOT NULL DEFAULT '',
  trigger text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'running',
  source_packet_digest text NOT NULL DEFAULT '',
  source_packet_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  selected_action text NOT NULL DEFAULT '',
  action_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  dry_run boolean NOT NULL DEFAULT true,
  provider text NOT NULL DEFAULT 'codex_exec',
  model text NOT NULL DEFAULT '',
  reasoning_effort text NOT NULL DEFAULT '',
  output_text text NOT NULL DEFAULT '',
  error text NOT NULL DEFAULT '',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT board_manager_runs_status_chk
    CHECK (status IN ('running', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS board_manager_runs_recent_idx
  ON board_manager_runs (scope, started_at DESC, id);

CREATE TABLE IF NOT EXISTS board_manager_action_results (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES board_manager_runs(id) ON DELETE CASCADE,
  action text NOT NULL DEFAULT '',
  target_type text NOT NULL DEFAULT '',
  target_id text NOT NULL DEFAULT '',
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS board_manager_action_results_run_idx
  ON board_manager_action_results (run_id, created_at DESC, id);
