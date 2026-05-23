ALTER TABLE board_manager_runs
  ADD COLUMN IF NOT EXISTS micro_summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS micro_summary_text text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS board_manager_runs_micro_summary_recent_idx
  ON board_manager_runs (scope, completed_at DESC, id)
  WHERE micro_summary_text <> '';
