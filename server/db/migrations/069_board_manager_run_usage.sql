ALTER TABLE board_manager_runs
  ADD COLUMN IF NOT EXISTS usage_json jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS board_manager_runs_usage_recent_idx
  ON board_manager_runs (completed_at DESC, id)
  WHERE status = 'completed';
