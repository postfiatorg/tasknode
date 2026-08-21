CREATE TABLE IF NOT EXISTS network_task_allocations (
  id text PRIMARY KEY,
  idempotency_key text NOT NULL DEFAULT '',
  project_id text NOT NULL REFERENCES network_projects(id) ON DELETE CASCADE,
  task_class text NOT NULL DEFAULT 'network',
  allocation_status text NOT NULL DEFAULT 'candidate',
  task_request_id text NOT NULL DEFAULT '',
  generated_task_id text NOT NULL DEFAULT '',
  candidate_account_id text NOT NULL DEFAULT '',
  candidate_wallet_address text NOT NULL DEFAULT '',
  candidate_profile_id text NOT NULL DEFAULT '',
  candidate_profile_digest text NOT NULL DEFAULT '',
  allocation_reason_summary text NOT NULL DEFAULT '',
  project_need_summary text NOT NULL DEFAULT '',
  reward_min_pft numeric(20, 6) NOT NULL DEFAULT 10000,
  reward_max_pft numeric(20, 6) NOT NULL DEFAULT 50000,
  cadence_policy_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_task_allocations_class_chk
    CHECK (task_class IN ('network', 'alpha')),
  CONSTRAINT network_task_allocations_status_chk
    CHECK (allocation_status IN ('candidate', 'queued', 'proposed', 'accepted', 'submitted', 'verification_requested', 'verification_response_submitted', 'reward_decided', 'refused', 'rejected', 'cancelled', 'expired', 'rerouted', 'rewarded', 'completed', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS network_task_allocations_idempotency_idx
  ON network_task_allocations (idempotency_key)
  WHERE idempotency_key <> '';

CREATE INDEX IF NOT EXISTS network_task_allocations_project_status_idx
  ON network_task_allocations (project_id, allocation_status, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS network_task_allocations_candidate_idx
  ON network_task_allocations (candidate_account_id, candidate_wallet_address, allocation_status, updated_at DESC);

CREATE INDEX IF NOT EXISTS network_task_allocations_task_request_idx
  ON network_task_allocations (task_request_id)
  WHERE task_request_id <> '';

CREATE TABLE IF NOT EXISTS network_task_generation_jobs (
  id text PRIMARY KEY,
  idempotency_key text NOT NULL DEFAULT '',
  allocation_id text NOT NULL REFERENCES network_task_allocations(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES network_projects(id) ON DELETE CASCADE,
  task_class text NOT NULL DEFAULT 'network',
  candidate_account_id text NOT NULL DEFAULT '',
  candidate_wallet_address text NOT NULL DEFAULT '',
  reward_min_pft numeric(20, 6) NOT NULL DEFAULT 10000,
  reward_max_pft numeric(20, 6) NOT NULL DEFAULT 50000,
  status text NOT NULL DEFAULT 'queued',
  trigger text NOT NULL DEFAULT 'board_manager',
  board_manager_run_id text NOT NULL DEFAULT '',
  request_id text NOT NULL DEFAULT '',
  source_payload_digest text NOT NULL DEFAULT '',
  source_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_payload_text text NOT NULL DEFAULT '',
  provider text NOT NULL DEFAULT 'tasknode',
  model text NOT NULL DEFAULT 'task_generation_worker',
  prompt_version text NOT NULL DEFAULT 'taskgen_network_v1',
  request_bundle_cid text NOT NULL DEFAULT '',
  generated_task_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  task_id text NOT NULL DEFAULT '',
  offer_cid text NOT NULL DEFAULT '',
  offer_tx_hash text NOT NULL DEFAULT '',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_task_generation_jobs_class_chk
    CHECK (task_class IN ('network', 'alpha')),
  CONSTRAINT network_task_generation_jobs_status_chk
    CHECK (status IN ('queued', 'running', 'generated', 'published', 'link_failed', 'failed'))
);

CREATE INDEX IF NOT EXISTS network_task_generation_jobs_status_idx
  ON network_task_generation_jobs (status, next_attempt_at, created_at, id);

CREATE UNIQUE INDEX IF NOT EXISTS network_task_generation_jobs_idempotency_idx
  ON network_task_generation_jobs (idempotency_key)
  WHERE idempotency_key <> '';

CREATE INDEX IF NOT EXISTS network_task_generation_jobs_project_idx
  ON network_task_generation_jobs (project_id, status, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS network_task_generation_jobs_request_idx
  ON network_task_generation_jobs (request_id)
  WHERE request_id <> '';
