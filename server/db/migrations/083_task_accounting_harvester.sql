CREATE TABLE IF NOT EXISTS task_accounting_harvests (
  task_id text PRIMARY KEY,
  request_id text NOT NULL DEFAULT '',
  account_id text NOT NULL DEFAULT '',
  subject_wallet text NOT NULL DEFAULT '',
  project_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  title text NOT NULL DEFAULT '',
  task_proposal text NOT NULL DEFAULT '',
  submission_requirement_text text NOT NULL DEFAULT '',
  reward_offer_pft numeric(18, 6) NOT NULL DEFAULT 0,
  reward_actual_pft numeric(18, 6) NOT NULL DEFAULT 0,
  rewarded_at timestamptz,
  reward_event_tx_hash text NOT NULL DEFAULT '',
  reward_event_cid text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'queued',
  classification text NOT NULL DEFAULT 'not_harvested',
  requires_action boolean NOT NULL DEFAULT false,
  action_category text NOT NULL DEFAULT '',
  suggested_action text NOT NULL DEFAULT '',
  assessment_summary text NOT NULL DEFAULT '',
  confidence numeric(6, 5) NOT NULL DEFAULT 0,
  source_packet_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  prompt_version text NOT NULL DEFAULT '',
  prompt_digest text NOT NULL DEFAULT '',
  response_id text NOT NULL DEFAULT '',
  usage_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  worker_id text NOT NULL DEFAULT '',
  worker_attempt_id text NOT NULL DEFAULT '',
  worker_attempt_count integer NOT NULL DEFAULT 0,
  worker_claimed_at timestamptz,
  worker_heartbeat_at timestamptz,
  completed_at timestamptz,
  resolved_at timestamptz,
  resolved_by_account_id text NOT NULL DEFAULT '',
  resolution_note text NOT NULL DEFAULT '',
  last_error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_accounting_harvests_status_chk
    CHECK (status IN ('queued', 'harvesting', 'harvested', 'failed')),
  CONSTRAINT task_accounting_harvests_classification_chk
    CHECK (classification IN ('not_harvested', 'requires_action', 'no_action', 'unknown'))
);

CREATE INDEX IF NOT EXISTS task_accounting_harvests_status_idx
  ON task_accounting_harvests (status, updated_at ASC, task_id);

CREATE INDEX IF NOT EXISTS task_accounting_harvests_classification_idx
  ON task_accounting_harvests (classification, completed_at DESC, task_id);

CREATE INDEX IF NOT EXISTS task_accounting_harvests_account_idx
  ON task_accounting_harvests (account_id, rewarded_at DESC, task_id);

CREATE INDEX IF NOT EXISTS task_accounting_harvests_rewarded_idx
  ON task_accounting_harvests (rewarded_at DESC, task_id);

CREATE INDEX IF NOT EXISTS task_accounting_harvests_unresolved_idx
  ON task_accounting_harvests (requires_action, completed_at DESC, task_id)
  WHERE resolved_at IS NULL;
