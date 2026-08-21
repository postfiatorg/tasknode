CREATE TABLE IF NOT EXISTS board_manager_scopes (
  scope text PRIMARY KEY,
  status text NOT NULL DEFAULT 'enabled',
  cadence_seconds integer NOT NULL DEFAULT 900,
  max_actions_per_hour integer NOT NULL DEFAULT 4,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_enqueued_at timestamptz,
  last_run_id text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT board_manager_scopes_status_chk
    CHECK (status IN ('enabled', 'paused', 'disabled')),
  CONSTRAINT board_manager_scopes_cadence_chk
    CHECK (cadence_seconds BETWEEN 60 AND 86400),
  CONSTRAINT board_manager_scopes_max_actions_chk
    CHECK (max_actions_per_hour BETWEEN 0 AND 200)
);

CREATE INDEX IF NOT EXISTS board_manager_scopes_due_idx
  ON board_manager_scopes (status, next_run_at, scope);

CREATE TABLE IF NOT EXISTS board_manager_jobs (
  id text PRIMARY KEY,
  scope text NOT NULL DEFAULT 'global_hive',
  trigger text NOT NULL DEFAULT '',
  reason text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'queued',
  idempotency_key text NOT NULL DEFAULT '',
  run_after timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  claimed_by text NOT NULL DEFAULT '',
  claimed_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  run_id text NOT NULL DEFAULT '',
  last_error text NOT NULL DEFAULT '',
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT board_manager_jobs_status_chk
    CHECK (status IN ('queued', 'running', 'deferred', 'completed', 'failed', 'cancelled')),
  CONSTRAINT board_manager_jobs_attempt_chk
    CHECK (attempt_count >= 0 AND max_attempts BETWEEN 1 AND 20)
);

CREATE INDEX IF NOT EXISTS board_manager_jobs_due_idx
  ON board_manager_jobs (scope, status, run_after, created_at, id);

CREATE INDEX IF NOT EXISTS board_manager_jobs_status_idx
  ON board_manager_jobs (status, updated_at DESC, id);

CREATE UNIQUE INDEX IF NOT EXISTS board_manager_jobs_active_idempotency_idx
  ON board_manager_jobs (scope, idempotency_key)
  WHERE idempotency_key <> ''
    AND status IN ('queued', 'running', 'deferred');

INSERT INTO board_manager_scopes (scope, status, cadence_seconds, max_actions_per_hour, next_run_at)
VALUES ('global_hive', 'enabled', 900, 4, now())
ON CONFLICT (scope) DO NOTHING;

