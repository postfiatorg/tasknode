-- Linked append-only work ledger for Nazgul/orc task accounting.

CREATE TABLE IF NOT EXISTS orc_work_journal (
  id text PRIMARY KEY,
  interaction_id text NOT NULL DEFAULT '',
  source_task_id text NOT NULL DEFAULT '',
  review_disposition text NOT NULL DEFAULT '',
  followup_request_id text NOT NULL DEFAULT '',
  followup_task_id text NOT NULL DEFAULT '',
  task_action text NOT NULL DEFAULT '',
  event_cid text NOT NULL DEFAULT '',
  tx_hash text NOT NULL DEFAULT '',
  operator_handle text NOT NULL DEFAULT '',
  blocker text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'recorded',
  outcome_status text NOT NULL DEFAULT '',
  terminal boolean NOT NULL DEFAULT false,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orc_work_journal
  ADD COLUMN IF NOT EXISTS interaction_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS source_task_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS review_disposition text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS followup_request_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS followup_task_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS task_action text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS event_cid text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS tx_hash text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS operator_handle text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS blocker text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'recorded',
  ADD COLUMN IF NOT EXISTS outcome_status text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS terminal boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS idempotency_key text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS orc_work_journal_idempotency_idx
  ON orc_work_journal (idempotency_key)
  WHERE idempotency_key <> '';

CREATE INDEX IF NOT EXISTS orc_work_journal_interaction_idx
  ON orc_work_journal (interaction_id, created_at DESC)
  WHERE interaction_id <> '';

CREATE INDEX IF NOT EXISTS orc_work_journal_source_task_idx
  ON orc_work_journal (source_task_id, created_at DESC)
  WHERE source_task_id <> '';

CREATE INDEX IF NOT EXISTS orc_work_journal_followup_task_idx
  ON orc_work_journal (followup_task_id, created_at DESC)
  WHERE followup_task_id <> '';

CREATE INDEX IF NOT EXISTS orc_work_journal_operator_idx
  ON orc_work_journal (operator_handle, created_at DESC)
  WHERE operator_handle <> '';
