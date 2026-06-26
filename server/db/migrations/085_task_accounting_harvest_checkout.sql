ALTER TABLE task_accounting_harvests
  ADD COLUMN IF NOT EXISTS checked_out_at timestamptz,
  ADD COLUMN IF NOT EXISTS checked_out_by_account_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS checked_out_wallet_address text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS task_accounting_harvests_checked_out_idx
  ON task_accounting_harvests (checked_out_at DESC, task_id)
  WHERE checked_out_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_accounting_harvest_checkout_events (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES task_accounting_harvests(task_id) ON DELETE CASCADE,
  event_type text NOT NULL DEFAULT 'checked_out',
  account_id text NOT NULL DEFAULT '',
  wallet_address text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_accounting_harvest_checkout_events_type_chk
    CHECK (event_type IN ('checked_out'))
);

CREATE INDEX IF NOT EXISTS task_accounting_harvest_checkout_events_task_idx
  ON task_accounting_harvest_checkout_events (task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS task_accounting_harvest_checkout_events_account_idx
  ON task_accounting_harvest_checkout_events (account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS task_accounting_harvest_checkout_events_wallet_idx
  ON task_accounting_harvest_checkout_events (wallet_address, created_at DESC);
