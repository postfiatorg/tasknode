CREATE INDEX IF NOT EXISTS board_manager_runs_global_recent_idx
  ON board_manager_runs (started_at DESC, id DESC);
