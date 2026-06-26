ALTER TABLE task_requests
  ADD COLUMN IF NOT EXISTS worker_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS worker_attempt_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS worker_heartbeat_at timestamptz;

CREATE INDEX IF NOT EXISTS task_requests_generation_claim_idx
  ON task_requests (status, worker_heartbeat_at, worker_claimed_at, updated_at, request_id)
  WHERE generated_task_id = '';

CREATE INDEX IF NOT EXISTS task_requests_worker_attempt_idx
  ON task_requests (request_id, worker_attempt_id)
  WHERE status = 'generating';
