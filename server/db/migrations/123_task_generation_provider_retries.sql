ALTER TABLE task_requests
  ADD COLUMN IF NOT EXISTS worker_retry_after timestamptz;

CREATE INDEX IF NOT EXISTS task_requests_generation_retry_idx
  ON task_requests (worker_retry_after, updated_at, request_id)
  WHERE status IN ('published', 'queued')
    AND generated_task_id = '';
