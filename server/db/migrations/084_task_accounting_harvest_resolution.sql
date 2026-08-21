ALTER TABLE task_accounting_harvests
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_by_account_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS resolution_note text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS task_accounting_harvests_unresolved_idx
  ON task_accounting_harvests (requires_action, completed_at DESC, task_id)
  WHERE resolved_at IS NULL;
