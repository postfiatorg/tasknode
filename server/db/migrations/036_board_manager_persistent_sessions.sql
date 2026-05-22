CREATE TABLE IF NOT EXISTS board_manager_sessions (
  scope text PRIMARY KEY,
  session_id text NOT NULL DEFAULT '',
  session_path text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  model text NOT NULL DEFAULT '',
  reasoning_effort text NOT NULL DEFAULT '',
  last_run_id text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT board_manager_sessions_status_chk
    CHECK (status IN ('active', 'archived'))
);

ALTER TABLE board_manager_runs
  ADD COLUMN IF NOT EXISTS codex_session_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS codex_session_path text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS session_mode text NOT NULL DEFAULT 'untracked';

CREATE INDEX IF NOT EXISTS board_manager_sessions_updated_idx
  ON board_manager_sessions (status, updated_at DESC, scope);

