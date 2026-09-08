ALTER TABLE network_task_generation_jobs
  ADD COLUMN IF NOT EXISTS worker_attempt_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS worker_heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS network_generation_lease_idx
  ON network_task_generation_jobs (lease_expires_at, id)
  WHERE status = 'running';
