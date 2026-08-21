ALTER TABLE task_accounting_harvests
  ADD COLUMN IF NOT EXISTS resolution_outcome text NOT NULL DEFAULT '';

ALTER TABLE task_accounting_harvests
  DROP CONSTRAINT IF EXISTS task_accounting_harvests_resolution_outcome_chk;

ALTER TABLE task_accounting_harvests
  ADD CONSTRAINT task_accounting_harvests_resolution_outcome_chk
    CHECK (resolution_outcome IN ('', 'fixed', 'already_fixed', 'not_a_bug', 'duplicate'));

CREATE INDEX IF NOT EXISTS task_accounting_harvests_resolution_outcome_idx
  ON task_accounting_harvests (resolution_outcome, resolved_at DESC, task_id)
  WHERE resolved_at IS NOT NULL;
