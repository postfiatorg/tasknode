ALTER TABLE network_task_allocations
  ADD COLUMN IF NOT EXISTS idempotency_key text NOT NULL DEFAULT '';

ALTER TABLE network_task_generation_jobs
  ADD COLUMN IF NOT EXISTS idempotency_key text NOT NULL DEFAULT '';

ALTER TABLE network_task_generation_jobs
  DROP CONSTRAINT IF EXISTS network_task_generation_jobs_status_chk;

ALTER TABLE network_task_generation_jobs
  ADD CONSTRAINT network_task_generation_jobs_status_chk
    CHECK (status IN (
      'queued',
      'running',
      'generated',
      'published',
      'link_failed',
      'failed'
    ));

ALTER TABLE network_task_allocations
  DROP CONSTRAINT IF EXISTS network_task_allocations_status_chk;

ALTER TABLE network_task_allocations
  ADD CONSTRAINT network_task_allocations_status_chk
    CHECK (allocation_status IN (
      'candidate',
      'queued',
      'proposed',
      'accepted',
      'submitted',
      'verification_requested',
      'verification_response_submitted',
      'reward_decided',
      'refused',
      'rejected',
      'cancelled',
      'expired',
      'rerouted',
      'rewarded',
      'completed',
      'failed'
    ));

CREATE UNIQUE INDEX IF NOT EXISTS network_task_allocations_idempotency_idx
  ON network_task_allocations (idempotency_key)
  WHERE idempotency_key <> '';

CREATE UNIQUE INDEX IF NOT EXISTS network_task_generation_jobs_idempotency_idx
  ON network_task_generation_jobs (idempotency_key)
  WHERE idempotency_key <> '';
