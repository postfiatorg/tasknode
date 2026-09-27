ALTER TABLE decision_jobs
  ADD COLUMN IF NOT EXISTS context_snapshot_json jsonb;
